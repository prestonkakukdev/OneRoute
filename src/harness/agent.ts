// OneRoute Code: the agent loop and the sessions around it.
//
// A session works in a project folder the user added: directly in the folder, or in its own git worktree on its own
// branch. A run takes a prompt, routes it once (Jev + optimizer pick the model and effort, which then stay fixed for
// the run, so the prompt cache and the thread of the work survive), and loops: stream the model's answer, run the
// tools it asks for (after the permission check), feed the results back, until it calls `finish`, answers without
// tools, gets stuck, or the user stops it. When it calls `finish` after changing things, OneRoute runs the project's
// checks itself and hands failures back before the run ends. Every file change is checkpointed per message, and long
// conversations are compacted.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { CodeProject, CodeSession, Store } from '../db/store.js';
import type { Executor } from '../gateway/execute.js';
import { readSse } from '../gateway/sse.js';
import type { Router } from '../router/router.js';
import type { Mode } from '../taxonomy.js';
import type { ChatMessage, RouteDecision } from '../types.js';
import { explainWhy } from '../router/explain.js';
import { Checkpoints } from './checkpoints.js';
import { compactionLimits, pruneToolResults, SUMMARY_PROMPT, summaryCut, summaryMessage, transcript } from './compact.js';
import { checkPermission, type PermissionMode } from './permissions.js';
import { serveFolder, type StaticPreview } from './preview.js';
import { type ProcessInfo, ProcessManager } from './processes.js';
import { ROLES, reportSchema, type Report, type SubagentRole } from './subagents.js';
import { REPORT_TOOL, TOOLS, toolByName, toolDefinitions, truncate, type Tool, type ToolContext, type ToolOutput } from './tools.js';
import { type Check, type CheckResult, detectChecks, packageManager, readJson, runChecks } from './verify.js';
import { checkProjectFolder, createWorkspace, discardWorkspace, git, isGitRepo, listProjectFiles, repoRoot, saveToBranch, workspaceDiff } from './workspace.js';

export const SCREENSHOTS_DIR = join(homedir(), '.oneroute', 'screenshots');

export interface RunOptions {
  mode: Mode;
  permission: PermissionMode;
}

export interface StartOptions extends RunOptions {
  // Work on a separate git branch in its own worktree instead of editing the folder directly.
  isolated?: boolean;
}

export interface CodeEvent {
  seq?: number; // set for events stored in the timeline; live-only events (text deltas) have none
  type: string;
  data: unknown;
}

type Listener = (e: CodeEvent) => void;

interface ActiveRun {
  controller: AbortController;
  approvals: Map<string, (allowed: boolean) => void>;
}

// Cheap mode works in increments: after this many steps the run pauses and reports, and the user decides whether
// to continue. Balanced and Best have no step limit (a stuck loop still stops them).
const CHEAP_STEP_PAUSE = 25;
// The same tool call repeated this many times in a row is a stuck loop.
const LOOP_REPEATS = 3;

// Automatic checks that fail send the agent back to fix them this many times before the run ends anyway.
const CHECK_RETRIES: Record<Mode, number> = { cheap: 1, balanced: 2, best: 3 };

// A failed model turn is retried this many times (the last retry on the next-best model).
const STEP_RETRIES = 2;

// Errors worth another try: the provider stalled, was overloaded or rate-limited, or the stream broke. A request the
// provider rejects (bad input, context too long) fails the same way again, so it isn't retried.
export function retryable(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  if (status !== undefined) return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  return /timeout|timed out|idle|overloaded|rate.?limit|capacity|unavailable|temporar|upstream|terminated|socket|ECONNRESET|EPIPE|network|fetch failed|stream|5\d\d/i.test((err as Error).message ?? '');
}

// Keeps what a session teaches about a project: short, durable, and never secret.
const LEARN_PROMPT = `You keep a short memory of durable facts about a software project for a coding agent that works on it.
From the session below, pick out what future sessions should know that is not obvious from the code itself:
- how the user wants things done (their corrections and stated preferences),
- project conventions and commands (package manager, how to run tests, files that are generated and must not be edited),
- pitfalls discovered (what failed and why, and what works instead).
Do not keep: what anyone can see by reading the code (languages, frameworks, file layout), how the user asked for this one task to be carried out, details of this one task, anything already in memory, temporary state, or anything secret (keys, tokens, passwords, personal data).
If this session shows a learned entry is wrong, remove it by id.
Most sessions teach nothing new; then add nothing. At most 3 entries, each one plain sentence.
Answer with JSON only: {"add": ["..."], "remove": ["<id>"]}`;
const SECRETISH = /(sk-[a-z0-9]|api[_-]?key|token|password|secret|bearer\s)/i;

const READ_ONLY_TOOLS = new Set(['list_files', 'grep', 'read_file', 'wait', 'subagent', 'todo', 'finish']);

type Finished = { reason: string; summary?: string; verified?: string; next_steps?: string; checks?: 'passed' | 'failed' };

interface StreamedCall {
  id: string;
  name: string;
  args: string;
}

// Streams one model turn: text deltas go to the UI as they arrive; tool calls and reasoning details are assembled.
async function readTurn(body: ReadableStream<Uint8Array>, onText: (t: string) => void, onThinking: () => void) {
  let text = '';
  const calls: StreamedCall[] = [];
  const reasoning: Record<string, unknown>[] = [];
  let usage: { cost?: number; prompt_tokens?: number; completion_tokens?: number } | undefined;
  for await (const ev of readSse(body)) {
    const e = ev as {
      choices?: { delta?: { content?: string; reasoning?: string; reasoning_details?: Record<string, unknown>[]; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
      usage?: typeof usage;
      error?: { message?: string };
    };
    if (e.error) throw new Error(e.error.message ?? 'The model returned an error.');
    const d = e.choices?.[0]?.delta;
    if (d?.content) {
      text += d.content;
      onText(d.content);
    }
    if (d?.reasoning) onThinking();
    // Reasoning models need their reasoning details passed back with tool results; merge the streamed pieces.
    for (const r of d?.reasoning_details ?? []) {
      const i = typeof r.index === 'number' ? r.index : reasoning.length;
      const slot = (reasoning[i] ??= {});
      for (const [k, v] of Object.entries(r)) {
        if (k === 'index') continue;
        if (typeof v === 'string' && ['text', 'summary', 'data'].includes(k)) slot[k] = ((slot[k] as string | undefined) ?? '') + v;
        else if (v !== null && v !== undefined && v !== '') slot[k] = v;
      }
    }
    for (const tc of d?.tool_calls ?? []) {
      const slot = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name && !slot.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    if (e.usage) usage = e.usage;
  }
  return { text, calls: calls.filter(Boolean), reasoning: reasoning.filter(Boolean), usage };
}

function titleFrom(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line || 'Code session';
}

export class CodeHarness {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly previews = new Map<string, StaticPreview>();
  // Dev servers and watchers; their changes go to the app live (they don't belong in the stored timeline).
  readonly processes = new ProcessManager((sessionId, info) => this.emit(sessionId, 'process', info, false));

  constructor(
    private readonly store: Store,
    private readonly router: Router,
    private readonly executor: Executor,
  ) {
    // A run in progress when the server stopped is interrupted; its conversation is saved after every step, so it
    // can be resumed from where it got to.
    for (const s of store.listCodeSessions()) {
      if (s.status === 'running' || s.status === 'awaiting_approval') {
        store.updateCodeSession(s.id, { status: 'interrupted' });
        store.appendCodeEvent(s.id, 'finished', { reason: 'interrupted', summary: 'OneRoute restarted in the middle of this run. Resume to carry on from the last completed step.' });
      }
    }
  }

  // --- Projects: only folders the user adds explicitly (git optional) ------------------------------

  async addProject(path: string): Promise<CodeProject> {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a folder: ${path}`);
    const problem = checkProjectFolder(path);
    if (problem) throw new Error(problem);
    const root = (await isGitRepo(path)) ? await repoRoot(path) : path;
    return this.store.addCodeProject({ id: randomUUID(), name: basename(root), path: root });
  }

  // Forgets a project and its sessions: runs and processes stop, separate worktrees are deleted, and the session
  // history goes. Files in the project folder stay as they are.
  async removeProject(projectId: string): Promise<boolean> {
    for (const s of this.store.listCodeSessions().filter((x) => x.projectId === projectId)) await this.discard(s.id);
    return this.store.removeCodeProject(projectId);
  }

  // --- Sessions -----------------------------------------------------------------------------------

  async startSession(projectId: string, prompt: string, opts: StartOptions): Promise<CodeSession> {
    const project = this.store.listCodeProjects().find((p) => p.id === projectId);
    if (!project) throw new Error('Unknown project');
    if (!existsSync(project.path)) throw new Error(`The folder no longer exists: ${project.path}`);
    const id = randomUUID();
    const title = titleFrom(prompt);
    let session: CodeSession;
    if (opts.isolated) {
      if (!(await isGitRepo(project.path))) throw new Error('A separate branch needs a git repository. Work in the folder directly, or run `git init` there first.');
      session = this.store.createCodeSession({ id, projectId, title, inPlace: false, ...(await createWorkspace(project.path, id, title)) });
    } else {
      this.assertFolderFree(project.path);
      const isGit = await isGitRepo(project.path);
      const branch = isGit ? (await git(project.path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() : '';
      const head = isGit ? (await git(project.path, ['rev-parse', 'HEAD']).catch(() => '')).trim() : '';
      session = this.store.createCodeSession({ id, projectId, title, inPlace: true, worktree: project.path, branch, baseRef: branch, baseCommit: head });
    }
    void this.run(session.id, prompt, opts);
    return session;
  }

  // Two agents editing the same folder at once would trip over each other.
  private assertFolderFree(folder: string, except?: string): void {
    for (const id of this.active.keys()) {
      const s = this.store.getCodeSession(id);
      if (s && id !== except && s.inPlace && s.worktree === folder) throw new Error('Another session is already working in this folder. Stop it first.');
    }
  }

  // `auto` marks a message OneRoute wrote (resume, retry) rather than the user: it isn't learned from.
  continueSession(sessionId: string, prompt: string, opts: RunOptions, auto = false): void {
    if (this.active.has(sessionId)) throw new Error('This session is already running.');
    const s = this.store.getCodeSession(sessionId);
    if (!s || s.status === 'discarded') throw new Error('Unknown session');
    if (s.inPlace) this.assertFolderFree(s.worktree, sessionId);
    void this.run(sessionId, prompt, opts, auto);
  }

  // Carries on after a run stopped by an error or a restart; the conversation was saved after its last full step.
  resume(sessionId: string, opts: RunOptions): void {
    const s = this.store.getCodeSession(sessionId);
    if (!s) throw new Error('Unknown session');
    const why = s.status === 'error' ? 'The last step failed with an error.' : 'The run was interrupted by a restart.';
    this.continueSession(sessionId, `${why} Carry on with the task from where you left off; check the current state of the files first.`, opts, true);
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  stop(sessionId: string): boolean {
    const run = this.active.get(sessionId);
    if (!run) return false;
    run.controller.abort();
    for (const resolve of run.approvals.values()) resolve(false);
    return true;
  }

  approve(sessionId: string, approvalId: string, allowed: boolean): boolean {
    const resolve = this.active.get(sessionId)?.approvals.get(approvalId);
    if (!resolve) return false;
    resolve(allowed);
    return true;
  }

  async diff(sessionId: string) {
    const s = this.store.getCodeSession(sessionId);
    if (!s) throw new Error('Unknown session');
    return s.inPlace ? new Checkpoints(sessionId, s.worktree).diff() : workspaceDiff(s);
  }

  // In-place sessions: put every file the agent changed back the way it was.
  undo(sessionId: string): number {
    const s = this.store.getCodeSession(sessionId);
    if (!s) throw new Error('Unknown session');
    if (!s.inPlace) throw new Error('This session works on its own branch; discard it instead.');
    if (this.active.has(sessionId)) throw new Error('Stop the session before undoing its changes.');
    const restored = new Checkpoints(sessionId, s.worktree).undoAll();
    this.emit(sessionId, 'undone', { files: restored });
    this.emit(sessionId, 'diff', { files: [] });
    this.noteForAgent(sessionId, 'The user undid every change this session made to the files. Read files again before editing them.');
    return restored;
  }

  // Puts the files back to how they were before the user's message `turn` (the seq of its event), undoing that
  // message's changes and everything after it. The conversation stays; the agent is told what happened.
  async restoreTo(sessionId: string, turn: number): Promise<number> {
    const s = this.store.getCodeSession(sessionId);
    if (!s) throw new Error('Unknown session');
    if (this.active.has(sessionId)) throw new Error('Stop the session before restoring files.');
    const restored = new Checkpoints(sessionId, s.worktree).restoreTo(turn);
    const prompt = this.store.codeEvents(sessionId, turn - 1).find((e) => e.seq === turn && e.type === 'user')?.data as { text?: string } | undefined;
    this.emit(sessionId, 'restored', { turn, files: restored });
    this.emit(sessionId, 'diff', { files: (await this.diff(sessionId)).files });
    const quoted = prompt?.text ? `"${prompt.text.length > 120 ? `${prompt.text.slice(0, 119)}…` : prompt.text}"` : 'an earlier message';
    this.noteForAgent(sessionId, `The user restored the files to how they were before their message ${quoted}. Changes made from that message on are gone. Read files again before editing them.`);
    return restored;
  }

  // A note for the agent, added to the conversation it sees on its next run.
  private noteForAgent(sessionId: string, note: string): void {
    const messages = this.store.getCodeMessages(sessionId) as ChatMessage[];
    if (!messages.length) return;
    this.store.setCodeMessages(sessionId, [...messages, { role: 'user', content: `[OneRoute] ${note}` }]);
  }

  // Runs the project so the user can try it: its dev server if it has one, otherwise a local static server.
  async preview(sessionId: string): Promise<{ url?: string; kind: 'dev' | 'static'; process?: ProcessInfo }> {
    const s = this.store.getCodeSession(sessionId);
    if (!s) throw new Error('Unknown session');
    const scripts = (readJson(join(s.worktree, 'package.json'))?.scripts ?? {}) as Record<string, string>;
    const script = ['dev', 'start', 'serve', 'preview'].find((n) => scripts[n]);
    if (script) {
      const pm = packageManager(s.worktree);
      const command = `${pm} run ${script}`;
      const needsInstall = !existsSync(join(s.worktree, 'node_modules'));
      const full = needsInstall ? `${pm} install && ${command}` : command;
      const running = this.processes.findRunning(sessionId, full) ?? this.processes.findRunning(sessionId, command);
      const p = running ?? this.processes.start(sessionId, full, s.worktree, `Preview: ${command}`);
      await this.processes.settle(p.id, needsInstall ? 180_000 : 30_000);
      const now = this.processes.get(sessionId, p.id)!;
      if (now.status === 'exited') throw new Error(`The dev server stopped (exit code ${now.exitCode}). See its output in the Run tab.`);
      return { url: now.url, kind: 'dev', process: now };
    }
    let preview = this.previews.get(sessionId);
    if (!preview) {
      preview = await serveFolder(s.worktree);
      this.previews.set(sessionId, preview);
    }
    return { url: preview.url, kind: 'static' };
  }

  screenshotPath(sessionId: string, name: string): string | undefined {
    if (!/^[\w.-]+\.(jpg|png)$/.test(name)) return undefined;
    const path = join(SCREENSHOTS_DIR, sessionId, name);
    return existsSync(path) ? path : undefined;
  }

  async save(sessionId: string, message?: string): Promise<string | null> {
    const s = this.store.getCodeSession(sessionId);
    if (!s) throw new Error('Unknown session');
    if (s.inPlace) throw new Error('This session edits the folder directly; there is no separate branch to save to.');
    const commit = await saveToBranch(s, message ?? `OneRoute: ${s.title}`);
    if (commit) this.emit(sessionId, 'saved', { commit, branch: s.branch });
    return commit;
  }

  async discard(sessionId: string): Promise<void> {
    const s = this.store.getCodeSession(sessionId);
    if (!s) throw new Error('Unknown session');
    this.stop(sessionId);
    this.processes.stopSession(sessionId);
    this.previews.get(sessionId)?.close();
    this.previews.delete(sessionId);
    // In-place sessions leave the folder as it is (use undo first to revert); worktree sessions delete their copy.
    new Checkpoints(sessionId, s.worktree).drop();
    rmSync(join(SCREENSHOTS_DIR, sessionId), { recursive: true, force: true });
    if (!s.inPlace) {
      const project = this.store.listCodeProjects().find((p) => p.id === s.projectId);
      if (project) await discardWorkspace(project.path, s);
    }
    this.store.deleteCodeSession(sessionId);
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => set.delete(listener);
  }

  // Stored events become the session's timeline; live-only events (text deltas) just go to open streams.
  private emit(sessionId: string, type: string, data: unknown, persist = true): number | undefined {
    const seq = persist ? this.store.appendCodeEvent(sessionId, type, data) : undefined;
    for (const l of this.listeners.get(sessionId) ?? []) l({ seq, type, data });
    return seq;
  }

  // --- The loop -----------------------------------------------------------------------------------

  private async systemPrompt(session: CodeSession, opts: RunOptions, checks: Check[]): Promise<string> {
    const project = this.store.listCodeProjects().find((p) => p.id === session.projectId);
    const files = await listProjectFiles(session.worktree);
    const agentsFile = ['AGENTS.md', 'CLAUDE.md', '.cursorrules'].map((f) => join(session.worktree, f)).find((f) => existsSync(f));
    const instructions = agentsFile ? truncate(readFileSync(agentsFile, 'utf8'), 8000) : '';
    const memory = this.store.listCodeMemory(session.projectId).slice(-40);
    const pace =
      opts.mode === 'cheap'
        ? 'Cheap mode: work in one small increment. Make the smallest useful, working change toward the goal, verify it, then call finish and describe the next increment. Do not start a second increment.'
        : 'Keep going until the task is complete and verified, then call finish.';
    const plan =
      opts.permission === 'plan'
        ? 'Plan mode: you can only read. Investigate, then call finish with a concrete plan: the files to change, the steps, and how to verify.'
        : '';
    return [
      `You are OneRoute Code, a coding agent working in the user's project "${project?.name ?? basename(session.worktree)}".`,
      session.inPlace
        ? `Your working directory is the project folder (${session.worktree}); use paths relative to it. You are editing the user's files directly.`
        : `Your working directory is the project root; use paths relative to it. Your changes stay on branch ${session.branch} until the user reviews and merges them.`,
      '',
      'How to work:',
      '- Explore before changing things: list_files, grep, read_file. Read a file before editing it.',
      '- Make small, precise edits with edit_file; create new files with write_file. Match the project’s style and conventions.',
      '- Keep every tool call reasonably small (a few hundred lines at most). Build a big file in parts: write the skeleton first, then add sections with edit_file. Keep embedded data (word lists, fixtures) modest, or put it in its own file.',
      '- Verify your work: run the project’s tests, type checks or build with bash when they exist, and fix what you break.',
      '- Anything a browser shows (HTML, CSS, front-end JS, web apps): check it with check_page, which opens it in a real headless browser. Look for console errors, and use steps and read to try the interaction you built (type into inputs, click buttons, read the results).',
      '- A page the user opens straight from disk (file://) cannot load <script type="module"> or fetch local files; for plain pages use classic <script src> tags, or give the project a dev server.',
      '- Start dev servers and watchers with bash background: true (never plain bash, it would wait for the timeout), then check_page the URL they print.',
      '- Use subagent to keep your context clean: explore for finding things in a large codebase or making sense of long logs; review for a second opinion on non-trivial changes before you finish.',
      '- Use wait (not repeated process_output calls) to wait for a dev server or build.',
      '- Use todo to keep a short task list for multi-step work.',
      session.inPlace
        ? '- Do not commit, push, or switch branches unless the user asks you to.'
        : '- Do not commit, push, or switch branches; the user reviews the work and merges it.',
      '- When you are done, call finish with a short summary, how you verified it, and anything left to do.',
      checks.length
        ? `- When you call finish, OneRoute runs these checks itself and sends failures back to you: ${checks.map((c) => (c.command ? `${c.name} (\`${c.command}\`)` : `${c.name} (opens ${c.page} from disk and looks for errors)`)).join(', ')}. Run them yourself first.`
        : '',
      pace,
      plan,
      instructions ? `\nProject instructions (${basename(agentsFile!)}):\n${instructions}` : '',
      memory.length ? `\nProject memory (what earlier sessions learned about this project; follow it unless the user says otherwise):\n${memory.map((m) => `- ${m.text}`).join('\n')}` : '',
      `\nProject files (${files.length}):\n${files.slice(0, 400).join('\n')}${files.length > 400 ? `\n… ${files.length - 400} more` : ''}`,
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  private async run(sessionId: string, prompt: string, opts: RunOptions, auto = false): Promise<void> {
    const session = this.store.getCodeSession(sessionId)!;
    const run: ActiveRun = { controller: new AbortController(), approvals: new Map() };
    this.active.set(sessionId, run);
    const signal = run.controller.signal;
    this.store.updateCodeSession(sessionId, { status: 'running' });
    const turn = this.emit(sessionId, 'user', { text: prompt, mode: opts.mode, permission: opts.permission, ...(auto ? { auto: true } : {}) })!;
    const checkpoints = new Checkpoints(sessionId, session.worktree);
    checkpoints.beginTurn(turn);

    const history = (this.store.getCodeMessages(sessionId) as ChatMessage[]).filter((m) => m.role !== 'system');
    const tools = opts.permission === 'plan' ? TOOLS.filter((t) => READ_ONLY_TOOLS.has(t.name)) : TOOLS;
    const toolDefs = toolDefinitions(tools);
    const checks = opts.permission === 'plan' ? [] : detectChecks(session.worktree);
    const messages: ChatMessage[] = [{ role: 'system', content: await this.systemPrompt(session, opts, checks) }, ...history, { role: 'user', content: prompt }];
    const ctx: ToolContext = {
      root: session.worktree,
      reads: new Map(),
      signal,
      beforeWrite: (full) => checkpoints.beforeWrite(full),
      beforeCommand: () => checkpoints.beforeCommand(),
      sessionId,
      processes: this.processes,
      screenshotDir: join(SCREENSHOTS_DIR, sessionId),
    };
    let finished: Finished | undefined;
    let decision: RouteDecision | undefined;
    let checkResults: CheckResult[] | undefined;
    const failures: string[] = []; // failed tool calls, for what the session teaches about the project

    try {
      // Route once for the run; the model and effort stay fixed so the prompt cache and the thread survive.
      decision = await this.router.route(
        { messages, tools: toolDefs, stream: true },
        { mode: opts.mode, sessionId, sessionExplicit: true, web: 'off' },
      );
      const routed = decision;
      ctx.spawn = (role, task) => this.runSubagent(sessionId, run, role, task, opts, routed, ctx);
      this.emit(sessionId, 'route', {
        role: 'implementer',
        modelId: routed.modelId,
        effort: routed.effort,
        why: explainWhy(routed),
        estCostUsd: routed.candidates[0]?.estCostUsd,
      });
      const contextLength = this.store.listModels({ includeDisabled: true }).find((m) => m.id === routed.modelId)?.contextLength ?? 128_000;
      const limits = compactionLimits(opts.mode, contextLength);
      let current = routed; // becomes the next-best model if the chosen one keeps failing
      const nextDecision = (): RouteDecision => {
        const d = { ...current, requestId: `rt_${randomUUID().replaceAll('-', '').slice(0, 20)}` };
        this.store.recordDecision(d, `[code] ${session.title} · step`);
        return d;
      };

      let steps = 0;
      let lastCall = '';
      let repeats = 0;
      let changed = false; // edits or commands ran this run, so the checks are worth running
      let retries = 0;
      while (!signal.aborted && !finished) {
        steps += 1;
        const stepDecision = steps === 1 ? routed : nextDecision();

        const { result, turn: turnResult } = await this.streamStep(
          sessionId,
          { messages, tools: toolDefs, tool_choice: 'auto', stream: true },
          stepDecision,
          signal,
          { onText: (t) => this.emit(sessionId, 'text_delta', { text: t }, false), onThinking: () => this.emit(sessionId, 'thinking', {}, false), onSwitch: (d) => (current = d) },
        );
        const cost = turnResult.usage?.cost ?? 0;
        this.store.updateCodeSession(sessionId, { addCost: cost });
        this.emit(sessionId, 'step', { step: steps, model: result.servedModel, effort: result.servedEffort, costUsd: cost, promptTokens: turnResult.usage?.prompt_tokens, completionTokens: turnResult.usage?.completion_tokens });

        messages.push({
          role: 'assistant',
          content: turnResult.text || null,
          ...(turnResult.calls.length
            ? { tool_calls: turnResult.calls.map((c) => ({ id: c.id || `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) }
            : {}),
          ...(turnResult.reasoning.length ? { reasoning_details: turnResult.reasoning } : {}),
        });
        if (turnResult.text.trim()) this.emit(sessionId, 'assistant', { text: turnResult.text });
        if (!turnResult.calls.length) {
          finished = { reason: 'answered' };
          break;
        }

        let touched = false;
        let finishIndex = -1;
        const toolCalls = (messages.at(-1) as unknown as { tool_calls: { id: string; function: { name: string; arguments: string } }[] }).tool_calls;
        for (const call of toolCalls) {
          if (signal.aborted) break;
          const output = await this.runTool(sessionId, run, call, opts.permission, tools.map((t) => t.name), ctx, (f) => (finished = f));
          if (output.changed) touched = changed = true;
          if (!output.ok) failures.push(`${call.function.name}: ${output.text.slice(0, 300)}`);
          messages.push({ role: 'tool', tool_call_id: call.id, content: output.text });
          if (call.function.name === 'finish' && output.ok) finishIndex = messages.length - 1;
          const key = `${call.function.name}:${call.function.arguments}`;
          repeats = key === lastCall ? repeats + 1 : 1;
          lastCall = key;
          if (repeats >= LOOP_REPEATS) {
            finished = { reason: 'loop', summary: `Stopped: the agent repeated the same ${call.function.name} call ${LOOP_REPEATS} times in a row.` };
            break;
          }
        }
        if (touched) {
          const { files } = await this.diff(sessionId);
          this.emit(sessionId, 'diff', { files });
        }
        // Saved after every step, so a run cut off by a restart can resume from here.
        this.store.setCodeMessages(sessionId, messages.slice(1));

        // Done, by the agent's account: run the project's checks before the run ends.
        const done = finished as Finished | undefined;
        // The project may have gained tests or pages during the run, so look for checks again.
        const finalChecks = opts.permission === 'plan' ? [] : detectChecks(session.worktree);
        if (done?.reason === 'finish' && changed && finalChecks.length && !signal.aborted) {
          this.emit(sessionId, 'verifying', { checks: finalChecks.map((c) => c.name) }, false);
          checkResults = await runChecks(session.worktree, finalChecks, signal, ctx.screenshotDir);
          const failed = checkResults.filter((r) => !r.ok);
          this.emit(sessionId, 'verification', {
            attempt: retries + 1,
            results: checkResults.map((r) => ({ name: r.name, command: r.command, page: r.page, ok: r.ok, ms: r.ms, output: truncate(r.output, 4000), screenshot: r.screenshot ? basename(r.screenshot) : undefined })),
          });
          if (failed.length && retries < CHECK_RETRIES[opts.mode] && !signal.aborted) {
            retries += 1;
            finished = undefined;
            const report = failed.map((r) => `## ${r.name}${r.command ? ` (\`${r.command}\`)` : ` (${r.page})`}\n${truncate(r.output, 3000)}`).join('\n\n');
            const note = `Not finished: OneRoute ran the project's checks and ${failed.length === 1 ? 'one failed' : `${failed.length} failed`}. Fix the cause (not the check), then call finish again.\n\n${report}`;
            if (finishIndex >= 0) messages[finishIndex] = { ...messages[finishIndex]!, content: note };
            else messages.push({ role: 'user', content: note });
            continue;
          }
          done.checks = failed.length ? 'failed' : 'passed';
          if (failed.length) done.summary = `${done.summary ?? ''}\n\n**Checks still failing:** ${failed.map((r) => r.name).join(', ')}.`.trim();
        }

        if (!finished && opts.mode === 'cheap' && steps >= CHEAP_STEP_PAUSE) {
          finished = { reason: 'paused', summary: `Paused after ${steps} steps (Cheap mode works in increments). Send a message to continue.` };
        }

        // Keep the conversation inside the budget: clear old tool output, and summarise if that isn't enough.
        const promptTokens = turnResult.usage?.prompt_tokens ?? 0;
        if (!finished && promptTokens > limits.prune) {
          const saved = pruneToolResults(messages);
          if (promptTokens > limits.summarize) await this.summarize(sessionId, messages, nextDecision(), signal);
          else if (saved > 0) this.emit(sessionId, 'compacted', { kind: 'pruned', savedChars: saved, promptTokens });
        }
      }
      if (signal.aborted && !finished) finished = { reason: 'stopped', summary: 'Stopped.' };
    } catch (err) {
      if (signal.aborted) finished = { reason: 'stopped', summary: 'Stopped.' };
      else {
        this.emit(sessionId, 'error', { message: (err as Error).message });
        finished = { reason: 'error' };
      }
    } finally {
      this.store.setCodeMessages(sessionId, messages.slice(1));
      this.store.updateCodeSession(sessionId, { status: finished?.reason === 'error' ? 'error' : 'idle' });
      const files = checkpoints.turnFiles(turn);
      if (files) this.emit(sessionId, 'checkpoint', { turn, files });
      // Outcome signal for routing: did the model's work pass the project's own checks?
      if (decision && checkResults?.length) {
        const passed = checkResults.every((r) => r.ok);
        this.store.recordImplicitFeedback(decision.requestId, passed, `OneRoute Code checks ${passed ? 'passed' : 'failed'}: ${checkResults.map((r) => `${r.name} ${r.ok ? 'ok' : 'failed'}`).join(', ')}`);
      }
      this.emit(sessionId, 'finished', finished ?? { reason: 'stopped' });
      this.active.delete(sessionId);
      // Learn from the session in the background: corrections from the user and things that failed.
      const done = finished as Finished | undefined;
      const checksFailed = checkResults?.some((r) => !r.ok) ?? false;
      // A follow-up from the user themselves (often a correction); messages OneRoute wrote don't count.
      const followUp = !auto && this.store.codeEvents(sessionId, 0).filter((e) => e.type === 'user' && !(e.data as { auto?: boolean }).auto).length > 1;
      if (done && ['finish', 'answered', 'paused'].includes(done.reason) && (followUp || failures.length >= 2 || checksFailed)) {
        void this.learn(session, done.summary ?? '', [...failures, ...(checkResults ?? []).filter((r) => !r.ok).map((r) => `${r.name} check: ${r.output.slice(0, 300)}`)]).catch((err: Error) =>
          console.warn(`[code] memory extraction failed for session ${sessionId}: ${err.message}`),
        );
      }
    }
  }

  // --- Project memory ---------------------------------------------------------------------------------

  // Asks a cheap model what this session showed about the project that future sessions should know, and keeps it.
  private async learn(session: CodeSession, summary: string, failures: string[]): Promise<void> {
    const prompts = this.store
      .codeEvents(session.id, 0)
      .filter((e) => e.type === 'user' && !(e.data as { auto?: boolean }).auto)
      .map((e) => String((e.data as { text?: string }).text ?? ''))
      .slice(-5);
    const existing = this.store.listCodeMemory(session.projectId);
    const context = [
      `Current memory:\n${existing.length ? existing.map((m) => `[${m.id}] (${m.source}) ${m.text}`).join('\n') : '(empty)'}`,
      `The user's messages in this session, in order:\n${prompts.map((p, i) => `${i + 1}. ${truncate(p, 600)}`).join('\n')}`,
      `The agent's final summary:\n${truncate(summary, 800) || '(none)'}`,
      failures.length ? `What failed along the way:\n${failures.slice(0, 8).map((f) => `- ${f}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: LEARN_PROMPT },
      { role: 'user', content: context },
    ];
    const decision = await this.router.route({ messages }, { mode: 'cheap', sessionId: `${session.id}:memory`, sessionExplicit: true, web: 'off' });
    const result = await this.executor.execute({ messages, stream: false, max_tokens: 800 }, decision);
    if (!result.response.ok) throw new Error(`HTTP ${result.response.status}: ${(await result.response.text()).slice(0, 200)}`);
    const json = (await result.response.json()) as { choices?: { message?: { content?: string } }[]; usage?: { cost?: number } };
    this.store.updateCodeSession(session.id, { addCost: json.usage?.cost ?? 0 });
    const raw = json.choices?.[0]?.message?.content ?? '';
    let parsed: { add?: unknown; remove?: unknown };
    try {
      parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as typeof parsed;
    } catch {
      return;
    }
    const known = new Set(existing.map((m) => m.text.trim().toLowerCase()));
    const added = (Array.isArray(parsed.add) ? parsed.add : [])
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 3 && t.length <= 300)
      .map((t) => t.trim())
      .filter((t) => !known.has(t.toLowerCase()) && !SECRETISH.test(t))
      .slice(0, 3)
      .map((text) => this.store.addCodeMemory({ id: `mem_${randomUUID().slice(0, 8)}`, projectId: session.projectId, text, source: 'learned', sessionId: session.id }));
    const removable = new Map(existing.filter((m) => m.source === 'learned').map((m) => [m.id, m]));
    const removed = (Array.isArray(parsed.remove) ? parsed.remove : []).filter((id): id is string => typeof id === 'string' && removable.has(id));
    for (const id of removed) this.store.deleteCodeMemory(session.projectId, id);
    if (added.length || removed.length) {
      this.emit(session.id, 'memory', { added: added.map((m) => ({ id: m.id, text: m.text })), removed: removed.map((id) => removable.get(id)!.text) });
    }
  }

  // --- Helpers (sub-agents) -----------------------------------------------------------------------------

  // Runs a helper in its own context on its own route, and returns only its report to the main agent.
  private async runSubagent(sessionId: string, run: ActiveRun, role: SubagentRole, task: string, opts: RunOptions, parent: RouteDecision, parentCtx: ToolContext): Promise<ToolOutput> {
    const spec = ROLES[role];
    const id = `sa_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const signal = run.controller.signal;
    const session = this.store.getCodeSession(sessionId)!;
    const maxSteps = spec.maxSteps[opts.mode];
    const names = spec.tools.filter((n) => opts.permission !== 'plan' || READ_ONLY_TOOLS.has(n));
    const tools: Tool[] = [...names.map((n) => toolByName.get(n)!), REPORT_TOOL];
    const toolDefs = toolDefinitions(tools);

    let brief = task;
    if (role === 'review') {
      const { files, patch } = await this.diff(sessionId);
      if (files.length) brief += `\n\nThe changes made so far (${files.length} file${files.length === 1 ? '' : 's'}):\n${truncate(patch, 20_000)}`;
    }
    const files = await listProjectFiles(session.worktree);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `${spec.instructions}\n\nThe project is at ${session.worktree}; use paths relative to it. You have at most ${maxSteps} steps; when you are done, call report.\n\nProject files (${files.length}):\n${files.slice(0, 300).join('\n')}${files.length > 300 ? `\n… ${files.length - 300} more` : ''}`,
      },
      { role: 'user', content: brief },
    ];

    // Routed on its own task. A reviewer comes from a different model family than the main agent when one fits.
    const family = parent.modelId.split('/')[0];
    const deny = spec.differentFamily ? this.store.listModels({ includeDisabled: true }).filter((m) => m.id.startsWith(`${family}/`)).map((m) => m.id) : undefined;
    const routeReq = { messages, tools: toolDefs, stream: true };
    const prefs = { mode: opts.mode, sessionId: `${sessionId}:${id}`, sessionExplicit: true, web: 'off' as const };
    let decision: RouteDecision;
    try {
      decision = await this.router.route(routeReq, { ...prefs, denyModels: deny });
    } catch {
      decision = await this.router.route(routeReq, prefs);
    }
    this.emit(sessionId, 'subagent_start', { id, role, label: spec.label, task, modelId: decision.modelId, effort: decision.effort, why: explainWhy(decision) });

    const ctx: ToolContext = { ...parentCtx, reads: new Map(), spawn: undefined };
    let report: Report | undefined;
    let steps = 0;
    let cost = 0;
    let nudged = false;
    let lastCall = '';
    let repeats = 0;
    const limits = compactionLimits(opts.mode, this.store.listModels({ includeDisabled: true }).find((m) => m.id === decision.modelId)?.contextLength ?? 128_000);
    try {
      while (!signal.aborted && !report && steps < maxSteps + 1) {
        steps += 1;
        const d: RouteDecision = steps === 1 ? decision : { ...decision, requestId: `rt_${randomUUID().replaceAll('-', '').slice(0, 20)}` };
        if (steps > 1) this.store.recordDecision(d, `[code] ${session.title} · ${spec.label.toLowerCase()} step`);
        // Out of steps: the last turn may only report.
        const last = steps > maxSteps || repeats >= LOOP_REPEATS;
        const { result, turn: t } = await this.streamStep(
          sessionId,
          { messages, tools: last ? toolDefinitions([REPORT_TOOL]) : toolDefs, tool_choice: last ? { type: 'function', function: { name: 'report' } } : 'auto', stream: true },
          d,
          signal,
          { agent: id, onSwitch: (next) => (decision = next) },
        );
        const stepCost = t.usage?.cost ?? 0;
        cost += stepCost;
        this.store.updateCodeSession(sessionId, { addCost: stepCost });
        this.emit(sessionId, 'step', { agent: id, step: steps, model: result.servedModel, effort: result.servedEffort, costUsd: stepCost, promptTokens: t.usage?.prompt_tokens });
        const calls = t.calls.map((c) => ({ id: c.id || `call_${randomUUID().slice(0, 8)}`, function: { name: c.name, arguments: c.args || '{}' } }));
        messages.push({ role: 'assistant', content: t.text || null, ...(calls.length ? { tool_calls: calls.map((c) => ({ ...c, type: 'function' })) } : {}), ...(t.reasoning.length ? { reasoning_details: t.reasoning } : {}) });
        if (!calls.length) {
          if (nudged || last) report = { summary: t.text.trim() || 'The helper finished without a report.' };
          else {
            nudged = true;
            messages.push({ role: 'user', content: 'Call report with your findings now.' });
          }
          continue;
        }
        for (const call of calls) {
          if (call.function.name === 'report') {
            let input: unknown;
            try {
              input = JSON.parse(call.function.arguments);
            } catch {}
            const parsed = reportSchema.safeParse(input);
            if (parsed.success) {
              report = parsed.data;
              messages.push({ role: 'tool', tool_call_id: call.id, content: 'Reported.' });
              break;
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: `Invalid report: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
            continue;
          }
          const output = await this.runTool(sessionId, run, call, opts.permission, names, ctx, () => {}, id);
          messages.push({ role: 'tool', tool_call_id: call.id, content: output.text });
          const key = `${call.function.name}:${call.function.arguments}`;
          repeats = key === lastCall ? repeats + 1 : 1;
          lastCall = key;
        }
        if ((t.usage?.prompt_tokens ?? 0) > limits.prune) pruneToolResults(messages);
      }
    } catch (err) {
      if (!signal.aborted) report = { summary: `The helper failed: ${(err as Error).message}` };
    }
    report ??= { summary: signal.aborted ? 'Stopped.' : 'The helper ran out of steps before reporting.' };
    this.emit(sessionId, 'subagent_end', { id, role, report, steps, costUsd: cost });
    return { text: JSON.stringify({ helper: spec.label, ...report }), meta: { subagent: id } };
  }

  // One model turn, retried when the connection to the model fails (a provider going quiet mid-answer, overload,
  // a dropped stream). The first retry uses the same model; the last one switches to the next-best model from the
  // route, which the caller keeps for the rest of the run.
  private async streamStep(
    sessionId: string,
    body: Record<string, unknown>,
    decision: RouteDecision,
    signal: AbortSignal,
    hooks: { onText?: (t: string) => void; onThinking?: () => void; onSwitch?: (d: RouteDecision) => void; agent?: string },
  ) {
    let d = decision;
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.executor.execute(body as never, d, signal);
        if (!result.response.ok || !result.response.body) {
          const text = await result.response.text();
          let message = text.slice(0, 400);
          try {
            message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
          } catch {}
          throw Object.assign(new Error(message), { status: result.response.status });
        }
        const turn = await readTurn(result.response.body, hooks.onText ?? (() => {}), hooks.onThinking ?? (() => {}));
        return { result, turn };
      } catch (err) {
        if (signal.aborted || attempt > STEP_RETRIES || !retryable(err)) throw err;
        const message = (err as Error).message;
        const fresh = (next: RouteDecision) => ({ ...next, requestId: `rt_${randomUUID().replaceAll('-', '').slice(0, 20)}` });
        let switchedTo: string | undefined;
        const alt = attempt === STEP_RETRIES ? d.candidates.find((c) => c.modelId !== d.modelId) : undefined;
        if (alt) {
          d = fresh({ ...d, modelId: alt.modelId, effort: alt.effort });
          switchedTo = alt.modelId;
          hooks.onSwitch?.(d);
        } else d = fresh(d);
        this.store.recordDecision(d, `[code] retry after: ${message.slice(0, 80)}`);
        this.emit(sessionId, 'retry', { attempt, of: STEP_RETRIES, message: message.slice(0, 300), switchedTo, ...(hooks.agent ? { agent: hooks.agent } : {}) });
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
  }

  // Replaces the older part of the conversation with a summary written by the run's model.
  private async summarize(sessionId: string, messages: ChatMessage[], decision: RouteDecision, signal: AbortSignal): Promise<void> {
    const cut = summaryCut(messages);
    if (cut === null) return;
    try {
      const result = await this.executor.execute(
        { messages: [{ role: 'system', content: SUMMARY_PROMPT }, { role: 'user', content: transcript(messages.slice(1, cut)) }], stream: false, max_tokens: 4000 },
        decision,
        signal,
      );
      if (!result.response.ok) return;
      const json = (await result.response.json()) as { choices?: { message?: { content?: string } }[]; usage?: { cost?: number } };
      const summary = json.choices?.[0]?.message?.content?.trim();
      this.store.updateCodeSession(sessionId, { addCost: json.usage?.cost ?? 0 });
      if (!summary) return;
      messages.splice(1, cut - 1, summaryMessage(summary));
      this.emit(sessionId, 'compacted', { kind: 'summarized', messages: cut - 1, costUsd: json.usage?.cost ?? 0 });
    } catch {
      // Compaction is best effort; the run goes on with the pruned context.
    }
  }

  private async runTool(
    sessionId: string,
    run: ActiveRun,
    call: { id: string; function: { name: string; arguments: string } },
    permission: PermissionMode,
    available: string[],
    ctx: ToolContext,
    finish: (f: Finished) => void,
    agent?: string, // set for a helper's tool calls, so the app can show them inside the helper's card
  ): Promise<{ text: string; ok: boolean; changed?: boolean }> {
    const tag = agent ? { agent } : {};
    const { name } = call.function;
    const tool = toolByName.get(name);
    let input: unknown;
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      input = undefined;
    }
    this.emit(sessionId, 'tool_call', { id: call.id, name, input, toolClass: tool?.toolClass, ...tag });
    const done = (text: string, ok: boolean, changed = false, meta?: Record<string, unknown>) => {
      this.emit(sessionId, 'tool_result', { id: call.id, name, ok, output: truncate(text, 8000), ...(meta ? { meta } : {}), ...tag });
      return { text, ok, changed: changed && ok };
    };
    if (!tool || !available.includes(name)) return done(`Unknown or unavailable tool: ${name}.`, false);
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) return done(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`, false);

    const verdict = checkPermission(permission, tool.toolClass, tool.command?.(parsed.data));
    if (verdict.blocked) return done(verdict.blocked, false);
    if (!verdict.allowed) {
      const approvalId = randomUUID();
      // Ready for the answer before asking (a quick reply, or Stop, must not be lost).
      const answer = new Promise<boolean>((resolve) => {
        run.approvals.set(approvalId, resolve);
        run.controller.signal.addEventListener('abort', () => resolve(false), { once: true });
      });
      this.store.updateCodeSession(sessionId, { status: 'awaiting_approval' });
      this.emit(sessionId, 'approval_required', { approvalId, toolCallId: call.id, name, input: parsed.data, reason: verdict.reason, ...tag });
      const allowed = await answer;
      run.approvals.delete(approvalId);
      if (run.controller.signal.aborted) return done('Stopped by the user.', false);
      this.store.updateCodeSession(sessionId, { status: 'running' });
      this.emit(sessionId, 'approval_resolved', { approvalId, allowed });
      if (!allowed) return done('The user denied this action. Find another way, or ask the user in your final summary.', false);
    }

    try {
      const out = await tool.run(parsed.data, ctx);
      const text = typeof out === 'string' ? out : out.text;
      if (name === 'todo') this.emit(sessionId, 'todo', parsed.data);
      if (name === 'finish') finish({ reason: 'finish', ...(parsed.data as { summary: string; verified?: string; next_steps?: string }) });
      // Edits and shell commands change the project; page checks and process tools don't.
      const changes = tool.toolClass === 'edit' || name === 'bash';
      return done(text, true, changes, typeof out === 'string' ? undefined : out.meta);
    } catch (err) {
      return done(`Error: ${(err as Error).message}`, false);
    }
  }
}
