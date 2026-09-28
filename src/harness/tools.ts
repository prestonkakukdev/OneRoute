// The agent's tools. Each is one module: name, description, Zod input schema, permission class, and execution.
// Every path is resolved inside the session's worktree; nothing can reach outside it.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { checkPage, formatPageCheck, type PageStep } from './browser.js';
import { agentEnv } from './env.js';
import type { ToolClass } from './permissions.js';
import type { ProcessManager } from './processes.js';
import { formatReport, reportSchema, subagentInput, type SubagentRole } from './subagents.js';
import { git, isGitRepo, listProjectFiles } from './workspace.js';

export interface ToolContext {
  root: string; // the worktree
  reads: Map<string, string>; // path -> content hash when last read (edits require an up-to-date read)
  signal: AbortSignal;
  // Called before a file is written (the original is saved for the diff, checkpoints and undo).
  beforeWrite?: (fullPath: string) => void;
  // Called before a shell command; the returned function records what the command changed.
  beforeCommand?: () => Promise<() => Promise<void>>;
  sessionId: string;
  processes: ProcessManager;
  screenshotDir: string; // where page-check screenshots go
  // Starts a helper agent (main agent only; helpers have no spawn, so they can't start helpers of their own).
  spawn?: (role: SubagentRole, task: string) => Promise<ToolOutput>;
}

// A tool's result: text for the model, plus optional details for the app (e.g. a screenshot).
export type ToolOutput = string | { text: string; meta: Record<string, unknown> };

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  toolClass: ToolClass;
  // The command the permission check should look at (bash only).
  command?: (input: z.infer<S>) => string;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolOutput>;
}

// Infers each tool's input type from its schema.
const defineTool = <S extends z.ZodType>(t: Tool<S>): Tool<S> => t;

const MAX_OUTPUT = 30_000;
const hash = (s: string) => createHash('sha1').update(s).digest('hex');

// Keeps the start and end of long output; the middle of a log is the least useful part.
export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n[… ${text.length - max} characters cut …]\n\n${text.slice(-tail)}`;
}

// Resolves a path inside the worktree, refusing anything that escapes it (including via symlinks) or touches .git.
export function insideRoot(root: string, p: string): string {
  const full = resolve(root, p);
  const realRoot = realpathSync(root);
  let probe = full;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = resolve(realpathSync(probe), relative(probe, full));
  const rel = relative(realRoot, real);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path is outside the workspace: ${p}`);
  if (rel === '.git' || rel.startsWith(`.git${sep}`)) throw new Error('The .git directory is off limits.');
  return full;
}

const readTool = defineTool({
  name: 'read_file',
  description: 'Read a text file from the project, with line numbers. Optionally a line range. Read a file before editing it.',
  schema: z.object({
    path: z.string().describe('Path relative to the project root'),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
  }),
  toolClass: 'read',
  async run({ path, start_line, end_line }, ctx) {
    const full = insideRoot(ctx.root, path);
    if (!existsSync(full)) return `No such file: ${path}`;
    if (statSync(full).isDirectory()) return `${path} is a directory; use list_files.`;
    const content = readFileSync(full, 'utf8');
    ctx.reads.set(full, hash(content));
    const lines = content.split('\n');
    const from = (start_line ?? 1) - 1;
    const to = Math.min(end_line ?? from + 2000, lines.length);
    const body = lines
      .slice(from, to)
      .map((l, i) => `${String(from + i + 1).padStart(5)}  ${l}`)
      .join('\n');
    const more = to < lines.length ? `\n[… ${lines.length - to} more lines; read with start_line=${to + 1}]` : '';
    return truncate(body + more);
  },
});

const editTool = defineTool({
  name: 'edit_file',
  description:
    'Replace an exact snippet in a file you have read. old_string must match the file exactly (including indentation) and occur exactly once, unless replace_all is true. Prefer small, precise edits over rewriting files.',
  schema: z.object({
    path: z.string(),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  toolClass: 'edit',
  async run({ path, old_string, new_string, replace_all }, ctx) {
    const full = insideRoot(ctx.root, path);
    if (!existsSync(full)) return `No such file: ${path}. Use write_file to create it.`;
    const content = readFileSync(full, 'utf8');
    const seen = ctx.reads.get(full);
    if (!seen) return `Read ${path} with read_file before editing it.`;
    if (seen !== hash(content)) return `${path} changed since you last read it. Read it again, then edit.`;
    const count = content.split(old_string).length - 1;
    if (count === 0) return `old_string was not found in ${path}. Check whitespace and indentation, or read the file again.`;
    if (count > 1 && !replace_all) return `old_string occurs ${count} times in ${path}. Include more surrounding lines to make it unique, or set replace_all.`;
    const next = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, () => new_string);
    ctx.beforeWrite?.(full);
    writeFileSync(full, next);
    ctx.reads.set(full, hash(next));
    return `Edited ${path} (${replace_all ? count : 1} replacement${(replace_all ? count : 1) > 1 ? 's' : ''}).`;
  },
});

const writeTool = defineTool({
  name: 'write_file',
  description: 'Create a new file, or completely replace a small file you have read. For changes to existing files prefer edit_file.',
  schema: z.object({ path: z.string(), content: z.string() }),
  toolClass: 'edit',
  async run({ path, content }, ctx) {
    const full = insideRoot(ctx.root, path);
    if (existsSync(full)) {
      const seen = ctx.reads.get(full);
      if (!seen || seen !== hash(readFileSync(full, 'utf8'))) return `${path} exists. Read it first (or use edit_file for part of it).`;
    }
    ctx.beforeWrite?.(full);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    ctx.reads.set(full, hash(content));
    return `Wrote ${path} (${content.split('\n').length} lines).`;
  },
});

const listTool = defineTool({
  name: 'list_files',
  description: 'List project files (respects .gitignore). Optional glob pattern, e.g. "src/**/*.ts".',
  schema: z.object({ pattern: z.string().optional() }),
  toolClass: 'read',
  async run({ pattern }, ctx) {
    let files = await listProjectFiles(ctx.root);
    if (pattern) files = files.filter((f) => matchesGlob(f, pattern));
    const shown = files.slice(0, 500);
    return shown.length ? shown.join('\n') + (files.length > 500 ? `\n[… ${files.length - 500} more]` : '') : 'No files match.';
  },
});

const grepTool = defineTool({
  name: 'grep',
  description: 'Search file contents with a regular expression (extended syntax). Optional glob to limit files, e.g. "*.ts".',
  schema: z.object({ pattern: z.string().min(1), glob: z.string().optional(), ignore_case: z.boolean().optional() }),
  toolClass: 'read',
  async run({ pattern, glob, ignore_case }, ctx) {
    // git grep respects .gitignore in a repository; --no-index searches a plain folder.
    const scope = (await isGitRepo(ctx.root)) ? ['--untracked'] : ['--no-index', '--exclude-standard'];
    const args = ['grep', '-n', '-I', ...scope, '-E', ...(ignore_case ? ['-i'] : []), '-e', pattern, ...(glob ? ['--', glob] : [])];
    try {
      const out = await git(ctx.root, args);
      const lines = out.split('\n').filter(Boolean);
      return truncate(lines.slice(0, 200).join('\n') + (lines.length > 200 ? `\n[… ${lines.length - 200} more matches]` : ''));
    } catch (err) {
      return (err as { code?: number }).code === 1 ? 'No matches.' : `grep failed: ${(err as Error).message.slice(0, 300)}`;
    }
  },
});

const bashTool = defineTool({
  name: 'bash',
  description:
    'Run a shell command in the project root (the task workspace). Use for tests, builds, linters and git inspection. Non-interactive; default timeout 120s (max 600). For long-running commands (dev servers, watchers) set background: true; it returns once the command prints a local URL or after a few seconds, and keeps running (see process_output and stop_process).',
  schema: z.object({
    command: z.string().min(1),
    timeout_s: z.number().int().min(1).max(600).optional(),
    background: z.boolean().optional().describe('Keep the command running in the background (dev servers, watchers)'),
  }),
  toolClass: 'exec',
  command: (i) => i.command,
  async run({ command, timeout_s, background }, ctx) {
    if (background) {
      const p = ctx.processes.start(ctx.sessionId, command, ctx.root);
      await ctx.processes.settle(p.id, 15_000, ctx.signal);
      const now = ctx.processes.get(ctx.sessionId, p.id)!;
      const out = ctx.processes.output(ctx.sessionId, p.id, 3000) ?? '';
      const state = now.status === 'running' ? `is running in the background as ${p.id}` : `exited with code ${now.exitCode}`;
      return `The command ${state}.${now.url ? ` It serves ${now.url} (check it with check_page).` : ''}\nOutput so far:\n${out.trim() || '(none)'}`;
    }
    const recordChanges = await ctx.beforeCommand?.();
    const result = await new Promise<string>((resolveRun) => {
      const child = spawn('/bin/bash', ['-c', command], { cwd: ctx.root, env: agentEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const onData = (d: Buffer) => {
        out += d.toString();
        if (out.length > 4 * MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + out.slice(-MAX_OUTPUT);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timeout = setTimeout(() => child.kill('SIGKILL'), (timeout_s ?? 120) * 1000);
      const abort = () => child.kill('SIGKILL');
      ctx.signal.addEventListener('abort', abort, { once: true });
      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        ctx.signal.removeEventListener('abort', abort);
        const status = signal ? `killed (${signal === 'SIGKILL' && !ctx.signal.aborted ? 'timeout' : signal})` : `exit code ${code}`;
        resolveRun(`${truncate(out.trimEnd()) || '(no output)'}\n[${status}]`);
      });
      child.on('error', (err) => resolveRun(`Could not run the command: ${err.message}`));
    });
    await recordChanges?.().catch(() => {});
    return result;
  },
});

const processOutputTool = defineTool({
  name: 'process_output',
  description: 'Show the recent output and status of a background process started with bash background: true.',
  schema: z.object({ id: z.string().describe('The process id, e.g. p1') }),
  toolClass: 'meta',
  async run({ id }, ctx) {
    const p = ctx.processes.get(ctx.sessionId, id);
    if (!p) return `No process ${id} in this session.`;
    const status = p.status === 'running' ? 'running' : `exited (code ${p.exitCode})`;
    return `${id}: ${p.command} — ${status}${p.url ? ` — ${p.url}` : ''}\n${ctx.processes.output(ctx.sessionId, id) || '(no output)'}`;
  },
});

const stopProcessTool = defineTool({
  name: 'stop_process',
  description: 'Stop a background process started with bash background: true.',
  schema: z.object({ id: z.string() }),
  toolClass: 'meta',
  async run({ id }, ctx) {
    return ctx.processes.stop(ctx.sessionId, id) ? `Stopped ${id}.` : `No running process ${id} in this session.`;
  },
});

const waitTool = defineTool({
  name: 'wait',
  description:
    'Pause without using tokens: until a background process prints some text (e.g. "ready", "compiled", "Local:") or exits, or simply for some seconds. Cheaper than checking process_output over and over.',
  schema: z.object({
    seconds: z.number().int().min(1).max(600).describe('The longest to wait'),
    id: z.string().optional().describe('A background process to watch, e.g. p1'),
    until: z.string().optional().describe('Stop waiting when the process output contains this text (case-insensitive)'),
  }),
  toolClass: 'meta',
  async run({ seconds, id, until }, ctx) {
    const started = Date.now();
    const deadline = started + seconds * 1000;
    const matched = () => {
      if (!id) return false;
      const p = ctx.processes.get(ctx.sessionId, id);
      if (!p || p.status === 'exited') return true;
      return until ? (ctx.processes.output(ctx.sessionId, id, 64_000) ?? '').toLowerCase().includes(until.toLowerCase()) : false;
    };
    while (Date.now() < deadline && !ctx.signal.aborted && !matched()) await new Promise((r) => setTimeout(r, 250));
    const waited = `${((Date.now() - started) / 1000).toFixed(1)}s`;
    if (!id) return `Waited ${waited}.`;
    const p = ctx.processes.get(ctx.sessionId, id);
    if (!p) return `No process ${id} in this session.`;
    const why = p.status === 'exited' ? `it exited (code ${p.exitCode})` : until && matched() ? `its output contains "${until}"` : 'the time ran out';
    return `Waited ${waited}: ${why}.\n${ctx.processes.output(ctx.sessionId, id, 3000) || '(no output)'}`;
  },
});

const subagentTool = defineTool({
  name: 'subagent',
  description:
    'Hand a self-contained job to a helper agent with its own fresh context, and get back only its structured report. ' +
    'explore: find where something is implemented, how a feature works, or what a long log/test failure means, without filling your context with file contents. ' +
    'review: have a second model check your changes for bugs and missed requirements before you finish (mention what the task was and which files changed). ' +
    'The helper sees nothing of this conversation, so write the task out in full.',
  schema: subagentInput,
  toolClass: 'meta',
  async run({ role, task }, ctx) {
    if (!ctx.spawn) return 'Helpers cannot start helpers of their own. Do the work yourself.';
    return ctx.spawn(role, task);
  },
});

const reportTool = defineTool({
  name: 'report',
  description: 'Finish your job and hand your findings back to the agent that asked. Call it once, at the end.',
  schema: reportSchema,
  toolClass: 'meta',
  async run(input) {
    return formatReport('explore', input);
  },
});

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.localhost)(:\d+)?(\/|$)/i;

const checkPageTool = defineTool({
  name: 'check_page',
  description:
    'Open a web page in a real headless browser, the way the user would, and report console errors, uncaught exceptions, failed requests and the visible text (a screenshot is shown to the user). ' +
    'target is an HTML file in the project (opened straight from disk, like double-clicking it) or a local URL such as a dev server (http://localhost:5173). ' +
    'Use steps to interact (click, fill, press, select, wait) and read to get the text of elements afterwards, e.g. fill #bill with 100, click #tip-20, read #total. ' +
    'Use it after building or changing anything a browser shows.',
  schema: z.object({
    target: z.string().min(1).describe('Project-relative HTML file (e.g. index.html) or a local http URL'),
    steps: z
      .array(
        z.object({
          action: z.enum(['click', 'fill', 'press', 'select', 'wait', 'read']),
          selector: z.string().optional().describe('CSS selector (click, fill, select, read; optional for press)'),
          value: z.string().optional().describe('Text to type (fill) or option value (select)'),
          key: z.string().optional().describe('Key to press, e.g. Enter'),
          ms: z.number().int().min(0).max(10000).optional().describe('How long to wait'),
        }),
      )
      .optional(),
    read: z.array(z.string()).optional().describe('CSS selectors whose text to report after the steps'),
    width: z.number().int().min(320).max(2560).optional().describe('Viewport width (default 1280; use 390 for a phone)'),
  }),
  toolClass: 'exec',
  command: (i) => `check_page ${i.target}`,
  async run({ target, steps, read, width }, ctx) {
    let url: string;
    if (/^https?:\/\//i.test(target)) {
      if (!LOCAL_URL.test(target)) return 'check_page only opens pages on this computer: an HTML file in the project, or a localhost URL.';
      url = target;
    } else {
      const full = insideRoot(ctx.root, target.startsWith('file://') ? fileURLToPath(target) : target);
      if (!existsSync(full)) return `No such file: ${target}`;
      url = pathToFileURL(statSync(full).isDirectory() ? join(full, 'index.html') : full).href;
    }
    const pageSteps: PageStep[] = [];
    const reads = [...(read ?? [])];
    for (const s of steps ?? []) {
      if (s.action === 'read') {
        if (s.selector) reads.push(s.selector);
      } else if (s.action === 'wait') pageSteps.push({ action: 'wait', ms: s.ms ?? 500 });
      else if (s.action === 'press') pageSteps.push({ action: 'press', key: s.key ?? s.value ?? 'Enter', selector: s.selector });
      else if (!s.selector) return `Step "${s.action}" needs a selector.`;
      else if (s.action === 'click') pageSteps.push({ action: 'click', selector: s.selector });
      else pageSteps.push({ action: s.action, selector: s.selector, value: s.value ?? '' });
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const shot = join(ctx.screenshotDir, `${Date.now()}.jpg`);
    const width_ = width ?? 1280;
    const r = await checkPage({ url, steps: pageSteps, read: reads, screenshotPath: shot, viewport: { width: width_, height: width_ < 700 ? 844 : 800 }, signal: ctx.signal });
    return { text: formatPageCheck(r), meta: { screenshot: r.screenshot ? basename(r.screenshot) : undefined, problems: r.problems, url } };
  },
});

const todoTool = defineTool({
  name: 'todo',
  description: 'Set your task list (replaces the previous one). Keep it short; mark items done as you finish them.',
  schema: z.object({ items: z.array(z.object({ text: z.string(), status: z.enum(['pending', 'in_progress', 'done']) })) }),
  toolClass: 'meta',
  async run({ items }) {
    return `Task list updated (${items.filter((i) => i.status === 'done').length}/${items.length} done).`;
  },
});

const finishTool = defineTool({
  name: 'finish',
  description: 'End this run: what you changed, how you verified it, and (if work remains) the next step.',
  schema: z.object({ summary: z.string(), verified: z.string().optional(), next_steps: z.string().optional() }),
  toolClass: 'meta',
  async run() {
    return 'Run finished.';
  },
});

// The main agent's tools. Helpers get a subset of these plus `report`.
export const TOOLS: Tool[] = [listTool, grepTool, readTool, editTool, writeTool, bashTool, processOutputTool, stopProcessTool, waitTool, checkPageTool, subagentTool, todoTool, finishTool] as unknown as Tool[];
export const REPORT_TOOL = reportTool as unknown as Tool;
export const toolByName = new Map([...TOOLS, REPORT_TOOL].map((t) => [t.name, t]));

// OpenAI-style function definitions for the model.
export function toolDefinitions(tools: Tool[] = TOOLS) {
  return tools.map((t) => {
    const { $schema: _s, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return { type: 'function' as const, function: { name: t.name, description: t.description, parameters } };
  });
}
