import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleIcon,
  FilePenIcon,
  FilePlusIcon,
  FileSearchIcon,
  FileTextIcon,
  FolderTreeIcon,
  GitBranchIcon,
  AppWindowIcon,
  ArchiveIcon,
  BrainIcon,
  PlayIcon,
  ScanEyeIcon,
  TelescopeIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  ListTodoIcon,
  Loader2Icon,
  ShieldAlertIcon,
  SparklesIcon,
  TerminalIcon,
  XCircleIcon,
} from 'lucide-react';
import * as React from 'react';
import { Chip } from '@/components/chip';
import { Answer, ErrorBox } from '@/components/messages';
import { cn } from '@/lib/utils';
import { type CodeEvent, codeApi } from './api';

const enter = {
  initial: { opacity: 0, y: 6, filter: 'blur(4px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  transition: { duration: 0.3, ease: [0.2, 0, 0, 1] as const },
};

type Input = Record<string, unknown>;

// What a tool call looks like in one line.
function describe(name: string, input: Input): { icon: React.ReactNode; title: React.ReactNode } {
  const path = typeof input.path === 'string' ? input.path : '';
  switch (name) {
    case 'read_file':
      return { icon: <FileTextIcon />, title: <>Read <code>{path}</code></> };
    case 'edit_file':
      return { icon: <FilePenIcon />, title: <>Edited <code>{path}</code></> };
    case 'write_file':
      return { icon: <FilePlusIcon />, title: <>Wrote <code>{path}</code></> };
    case 'list_files':
      return { icon: <FolderTreeIcon />, title: <>Listed files{input.pattern ? <> matching <code>{String(input.pattern)}</code></> : null}</> };
    case 'grep':
      return { icon: <FileSearchIcon />, title: <>Searched for <code>{String(input.pattern ?? '')}</code></> };
    case 'bash':
      return {
        icon: <TerminalIcon />,
        title: (
          <>
            <code className="truncate">$ {String(input.command ?? '')}</code>
            {input.background ? <span className="text-muted-foreground/70 ml-2 text-[11.5px]">background</span> : null}
          </>
        ),
      };
    case 'check_page':
      return { icon: <AppWindowIcon />, title: <>Checked <code>{String(input.target ?? '')}</code> in a browser</> };
    case 'process_output':
      return { icon: <TerminalIcon />, title: <>Read the output of {String(input.id ?? '')}</> };
    case 'stop_process':
      return { icon: <TerminalIcon />, title: <>Stopped {String(input.id ?? '')}</> };
    default:
      return { icon: <SparklesIcon />, title: name };
  }
}

export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  input: Input;
  result?: { ok: boolean; output: string; meta?: { screenshot?: string; problems?: number; url?: string } };
}
export interface CheckRow {
  name: string;
  command?: string;
  page?: string;
  ok: boolean;
  ms: number;
  output: string;
  screenshot?: string;
}
export interface HelperItem {
  kind: 'helper';
  id: string;
  role: string;
  label: string;
  task: string;
  modelId: string;
  effort: string;
  why: string[];
  tools: ToolItem[];
  steps: number;
  costUsd: number;
  report?: { summary: string; findings?: { title: string; detail?: string; file?: string; line?: number; severity?: string }[]; files?: string[]; passed?: boolean };
}
export interface ApprovalItem {
  kind: 'approval';
  approvalId: string;
  name: string;
  input: Input;
  reason: string;
  resolved?: boolean;
  allowed?: boolean;
}
export type TimelineItem =
  | { kind: 'user'; seq?: number; text: string; mode?: string; permission?: string; checkpoint?: number; restored?: boolean; auto?: boolean }
  | { kind: 'route'; modelId: string; effort: string; why: string[]; role: string }
  | { kind: 'assistant'; text: string }
  | ToolItem
  | HelperItem
  | ApprovalItem
  | { kind: 'memory'; added: { id: string; text: string }[]; removed: string[] }
  | { kind: 'todo'; items: { text: string; status: string }[] }
  | { kind: 'diff'; files: { path: string }[] }
  | { kind: 'error'; message: string }
  | { kind: 'saved'; commit: string; branch: string }
  | { kind: 'undone'; files: number }
  | { kind: 'restored'; files: number }
  | { kind: 'verifying'; checks: string[] }
  | { kind: 'verification'; attempt: number; results: CheckRow[] }
  | { kind: 'compacted'; how: string; detail: number }
  | { kind: 'step'; costUsd: number }
  | { kind: 'retry'; message: string; attempt: number; of: number; switchedTo?: string }
  | { kind: 'finished'; reason: string; summary?: string; verified?: string; next_steps?: string; checks?: string };

// Folds the event stream into timeline items (tool results attach to their calls, approvals resolve in place).
export function buildTimeline(events: CodeEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const tools = new Map<string, ToolItem>();
  const approvals = new Map<string, ApprovalItem>();
  const users = new Map<number, Extract<TimelineItem, { kind: 'user' }>>();
  const helpers = new Map<string, HelperItem>();
  for (const { seq, type, data: d } of events) {
    // A helper's own tool calls and steps go inside its card.
    const helper = typeof d.agent === 'string' ? helpers.get(d.agent) : undefined;
    if (helper && type === 'tool_call') {
      const t: ToolItem = { kind: 'tool', id: String(d.id), name: String(d.name), input: (d.input as Input) ?? {} };
      tools.set(t.id, t);
      helper.tools.push(t);
      continue;
    }
    if (helper && type === 'step') {
      helper.steps += 1;
      helper.costUsd += Number(d.costUsd ?? 0);
      items.push({ kind: 'step', costUsd: Number(d.costUsd ?? 0) });
      continue;
    }
    if (type === 'retry') {
      if (!helper) items.push({ kind: 'retry', message: String(d.message ?? ''), attempt: Number(d.attempt ?? 1), of: Number(d.of ?? 2), switchedTo: d.switchedTo as string | undefined });
      continue;
    }
    if (type === 'subagent_start') {
      const h: HelperItem = { kind: 'helper', id: String(d.id), role: String(d.role), label: String(d.label), task: String(d.task ?? ''), modelId: String(d.modelId), effort: String(d.effort), why: (d.why as string[]) ?? [], tools: [], steps: 0, costUsd: 0 };
      helpers.set(h.id, h);
      items.push(h);
      continue;
    }
    if (type === 'subagent_end') {
      const h = helpers.get(String(d.id));
      if (h) h.report = d.report as HelperItem['report'];
      continue;
    }
    if (type === 'memory') {
      items.push({ kind: 'memory', added: (d.added as { id: string; text: string }[]) ?? [], removed: (d.removed as string[]) ?? [] });
      continue;
    }
    if (type === 'user') {
      const u = { kind: 'user' as const, seq, text: String(d.text ?? ''), mode: d.mode as string, permission: d.permission as string, auto: Boolean(d.auto) };
      if (seq) users.set(seq, u);
      items.push(u);
    } else if (type === 'checkpoint') {
      const u = users.get(Number(d.turn));
      if (u) u.checkpoint = Number(d.files ?? 0);
    } else if (type === 'restored') {
      for (const [s, u] of users) if (s >= Number(d.turn)) u.restored = true;
      items.push({ kind: 'restored', files: Number(d.files ?? 0) });
    } else if (type === 'undone') {
      for (const u of users.values()) u.restored = true;
      items.push({ kind: 'undone', files: Number(d.files ?? 0) });
    } else if (type === 'verifying') items.push({ kind: 'verifying', checks: (d.checks as string[]) ?? [] });
    else if (type === 'verification') {
      if (items.at(-1)?.kind === 'verifying') items.pop();
      items.push({ kind: 'verification', attempt: Number(d.attempt ?? 1), results: (d.results as CheckRow[]) ?? [] });
    } else if (type === 'compacted') items.push({ kind: 'compacted', how: String(d.kind), detail: Number(d.kind === 'summarized' ? d.messages : d.savedChars) || 0 });
    else if (type === 'route') items.push({ kind: 'route', modelId: String(d.modelId), effort: String(d.effort), why: (d.why as string[]) ?? [], role: String(d.role ?? 'implementer') });
    else if (type === 'assistant') items.push({ kind: 'assistant', text: String(d.text ?? '') });
    else if (type === 'tool_call') {
      if (d.name === 'todo' || d.name === 'finish' || d.name === 'subagent') continue; // shown as their own cards
      const item: ToolItem = { kind: 'tool', id: String(d.id), name: String(d.name), input: (d.input as Input) ?? {} };
      tools.set(item.id, item);
      items.push(item);
    } else if (type === 'tool_result') {
      const t = tools.get(String(d.id));
      if (t) t.result = { ok: Boolean(d.ok), output: String(d.output ?? ''), meta: d.meta as NonNullable<ToolItem['result']>['meta'] };
    } else if (type === 'approval_required') {
      const a: ApprovalItem = { kind: 'approval', approvalId: String(d.approvalId), name: String(d.name), input: (d.input as Input) ?? {}, reason: String(d.reason ?? '') };
      approvals.set(a.approvalId, a);
      items.push(a);
    } else if (type === 'approval_resolved') {
      const a = approvals.get(String(d.approvalId));
      if (a) Object.assign(a, { resolved: true, allowed: Boolean(d.allowed) });
    } else if (type === 'step') items.push({ kind: 'step', costUsd: Number(d.costUsd ?? 0) });
    else if (type === 'todo') items.push({ kind: 'todo', items: (d.items as { text: string; status: string }[]) ?? [] });
    else if (type === 'diff') items.push({ kind: 'diff', files: (d.files as { path: string }[]) ?? [] });
    else if (type === 'error') items.push({ kind: 'error', message: String(d.message ?? 'Something went wrong') });
    else if (type === 'saved') items.push({ kind: 'saved', commit: String(d.commit), branch: String(d.branch) });
    else if (type === 'finished') {
      if (items.at(-1)?.kind === 'verifying') items.pop();
      items.push({ kind: 'finished', reason: String(d.reason ?? ''), summary: d.summary as string, verified: d.verified as string, next_steps: d.next_steps as string, checks: d.checks as string });
    }
  }
  return items;
}

// A screenshot from a page check, fetched with the API key; click to open it full size.
export function Screenshot({ sessionId, name, className }: { sessionId: string; name: string; className?: string }) {
  const [src, setSrc] = React.useState<string>();
  React.useEffect(() => {
    let url: string | undefined;
    let cancelled = false;
    codeApi
      .screenshot(sessionId, name)
      .then((u) => (cancelled ? URL.revokeObjectURL(u) : setSrc((url = u))))
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [sessionId, name]);
  if (!src) return <div className={cn('bg-muted/40 aspect-[16/10] animate-pulse rounded-lg', className)} />;
  return (
    <a href={src} target="_blank" rel="noreferrer" className={cn('block overflow-hidden rounded-lg border', className)}>
      <img src={src} alt="Screenshot of the page" className="block w-full" />
    </a>
  );
}

function ToolCard({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const [open, setOpen] = React.useState(false);
  const { icon, title } = describe(item.name, item.input);
  const running = !item.result;
  const problems = item.result?.meta?.problems;
  const failed = (item.result && !item.result.ok) || Boolean(problems);
  const shot = item.result?.meta?.screenshot;
  return (
    <motion.div {...enter} className="rounded-lg border bg-white/[0.015]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors [&_code]:font-mono [&_code]:text-[12.5px] [&_code]:text-foreground/85"
      >
        <span className="flex shrink-0 opacity-70 [&_svg]:size-3.5">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {problems ? <span className="text-bad shrink-0 text-[11.5px]">{problems} problem{problems === 1 ? '' : 's'}</span> : null}
        {running ? <Loader2Icon className="size-3.5 animate-spin" aria-label="Running" /> : failed ? <XCircleIcon className="text-bad size-3.5" aria-label="Failed" /> : <CheckCircle2Icon className="text-good/80 size-3.5" aria-label="Done" />}
        <ChevronRightIcon className={cn('size-3.5 opacity-50 transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
      {shot ? (
        <div className="px-3 pb-3">
          <Screenshot sessionId={sessionId} name={shot} className="max-w-sm" />
        </div>
      ) : null}
      <AnimatePresence initial={false}>
        {open && item.result ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <pre className="text-muted-foreground max-h-80 overflow-auto border-t px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{item.result.output}</pre>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

function ApprovalCard({ item, onAnswer }: { item: ApprovalItem; onAnswer: (allow: boolean) => void }) {
  const { title } = describe(item.name, item.input);
  return (
    <motion.div {...enter} className="border-warn/30 bg-warn/[0.04] rounded-lg border p-3.5">
      <div className="text-warn flex items-center gap-2 text-[13px] font-medium">
        <ShieldAlertIcon className="size-4" aria-hidden />
        Approval needed
      </div>
      <div className="mt-2 text-[13px] [&_code]:font-mono [&_code]:text-[12.5px]">{title}</div>
      <p className="text-muted-foreground mt-1 text-[12.5px]">{item.reason}</p>
      {item.resolved ? (
        <div className={cn('mt-3 text-[12.5px] font-medium', item.allowed ? 'text-good' : 'text-bad')}>{item.allowed ? 'Allowed' : 'Denied'}</div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => onAnswer(true)} className="h-8 cursor-pointer rounded-lg bg-linear-to-b from-[#f7f7f7] to-white px-3.5 text-[13px] font-medium text-black active:scale-[0.97]">
            Allow
          </button>
          <button type="button" onClick={() => onAnswer(false)} className="text-muted-foreground hover:text-foreground h-8 cursor-pointer rounded-lg px-3.5 text-[13px] font-medium shadow-[inset_0_0_0_1px_var(--border)] active:scale-[0.97]">
            Deny
          </button>
        </div>
      )}
    </motion.div>
  );
}

const SEVERITY_TONE: Record<string, string> = { critical: 'text-bad', major: 'text-bad/90', minor: 'text-warn', info: 'text-muted-foreground' };

// A finding's detail, three lines until clicked.
function FindingDetail({ text }: { text: string }) {
  const [full, setFull] = React.useState(false);
  return (
    <button type="button" onClick={() => setFull((v) => !v)} title={full ? 'Show less' : 'Show all'} className={cn('text-muted-foreground block cursor-pointer text-left', !full && 'line-clamp-3')}>
      {text}
    </button>
  );
}

// A helper agent: its role, model and cost, its report, and (on request) the work it did in its own context.
function HelperCard({ item, sessionId }: { item: HelperItem; sessionId: string }) {
  const [open, setOpen] = React.useState(false);
  const running = !item.report;
  const Icon = item.role === 'review' ? ScanEyeIcon : TelescopeIcon;
  const r = item.report;
  return (
    <motion.div {...enter} className="rounded-lg border bg-white/[0.015]">
      <div className="flex items-center gap-2 px-3 pt-2.5 text-[12.5px]" title={item.why.join('\n')}>
        <Icon className="text-arc size-3.5 shrink-0" aria-hidden />
        <span className="font-medium">{item.label}</span>
        <Chip tone="soft">{item.modelId.split('/')[1] ?? item.modelId}</Chip>
        <span className="text-muted-foreground/70 truncate">
          {item.effort} · {item.steps} step{item.steps === 1 ? '' : 's'}
          {item.costUsd ? ` · ${item.costUsd < 0.01 ? `$${item.costUsd.toFixed(4)}` : `$${item.costUsd.toFixed(2)}`}` : ''}
        </span>
        <span className="flex-1" />
        {running ? <Loader2Icon className="text-muted-foreground size-3.5 animate-spin" aria-label="Working" /> : r?.passed === true ? <span className="text-good text-[11.5px] font-medium">passed</span> : r?.passed === false ? <span className="text-bad text-[11.5px] font-medium">found problems</span> : null}
      </div>
      <p className="text-muted-foreground line-clamp-2 px-3 pt-1 text-[12.5px]">{item.task}</p>
      {r ? (
        <div className="px-3 pt-2 [&_.prose-answer]:text-[13.5px]">
          <Answer text={r.summary} />
          {r.findings?.length ? (
            <ul className="mt-1.5 flex flex-col gap-1 text-[12.5px]">
              {r.findings.map((f, i) => (
                <li key={i} className="flex gap-2">
                  <span className={cn('shrink-0 font-medium', SEVERITY_TONE[f.severity ?? 'info'] ?? 'text-muted-foreground')}>{f.severity ?? '•'}</span>
                  <span className="min-w-0">
                    <span className="text-foreground/90">{f.title}</span>
                    {f.file ? (
                      <code className="text-muted-foreground ml-1.5 font-mono text-[11.5px]">
                        {f.file}
                        {f.line ? `:${f.line}` : ''}
                      </code>
                    ) : null}
                    {f.detail ? <FindingDetail text={f.detail} /> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {item.tools.length ? (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 px-3 pt-2 text-[12px] transition-colors">
          <ChevronRightIcon className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')} aria-hidden />
          {open ? 'Hide its work' : `Its work: ${item.tools.length} tool call${item.tools.length === 1 ? '' : 's'}, kept out of the main conversation`}
        </button>
      ) : null}
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="flex flex-col gap-2 px-3 pt-2">
              {item.tools.map((t) => (
                <ToolCard key={t.id} item={t} sessionId={sessionId} />
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <div className="h-2.5" />
    </motion.div>
  );
}

function VerificationCard({ item, sessionId }: { item: Extract<TimelineItem, { kind: 'verification' }>; sessionId: string }) {
  const [open, setOpen] = React.useState<number | null>(null);
  const failed = item.results.filter((r) => !r.ok).length;
  return (
    <motion.div {...enter} className={cn('rounded-lg border px-3.5 py-3', failed ? 'border-bad/25 bg-bad/[0.03]' : 'border-good/20 bg-good/[0.03]')}>
      <div className={cn('flex items-center gap-2 text-[12.5px] font-medium', failed ? 'text-bad' : 'text-good')}>
        <ShieldCheckIcon className="size-3.5" aria-hidden />
        {failed ? `Checks: ${failed} of ${item.results.length} failed${item.attempt > 1 ? ` (attempt ${item.attempt})` : ''} — sent back to fix` : `Checks passed${item.attempt > 1 ? ` on attempt ${item.attempt}` : ''}`}
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {item.results.map((r, j) => (
          <li key={j}>
            <button type="button" onClick={() => setOpen(open === j ? null : j)} className="hover:text-foreground text-muted-foreground flex w-full cursor-pointer items-center gap-2 text-left text-[12.5px]">
              {r.ok ? <CheckCircle2Icon className="text-good/80 size-3.5 shrink-0" /> : <XCircleIcon className="text-bad size-3.5 shrink-0" />}
              <span className="text-foreground/90">{r.name}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{r.command ?? r.page}</code>
              <span className="shrink-0 tabular-nums text-[11px]">{(r.ms / 1000).toFixed(1)}s</span>
              <ChevronRightIcon className={cn('size-3.5 shrink-0 opacity-50 transition-transform', open === j && 'rotate-90')} aria-hidden />
            </button>
            {open === j ? (
              <div className="mt-1.5 mb-1">
                {r.screenshot ? <Screenshot sessionId={sessionId} name={r.screenshot} className="mb-2 max-w-sm" /> : null}
                <pre className="text-muted-foreground max-h-72 overflow-auto rounded-lg border px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">{r.output}</pre>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </motion.div>
  );
}

// Some models double-escape line breaks inside tool arguments ("\\n" instead of a newline).
const unescape = (s?: string) => (s ?? '').replace(/\\n/g, '\n').replace(/\\t/g, '\t').trim();

const FINISH_LABEL: Record<string, string> = {
  finish: 'Done',
  answered: 'Answered',
  paused: 'Paused after an increment',
  stopped: 'Stopped',
  loop: 'Stopped: stuck in a loop',
  error: 'Stopped by an error',
  interrupted: 'Interrupted by a restart',
};

type UserItem = Extract<TimelineItem, { kind: 'user' }>;
type FinishedItem = Extract<TimelineItem, { kind: 'finished' }>;

// A run: the user's message, the work it caused, and how it ended. Notes between runs (undo, saved, …) stand alone.
type Segment = { kind: 'run'; key: string; user: UserItem; work: TimelineItem[]; answer?: string; finished?: FinishedItem } | { kind: 'note'; key: string; item: TimelineItem };

function segments(items: TimelineItem[]): Segment[] {
  const out: Segment[] = [];
  let open: Extract<Segment, { kind: 'run' }> | undefined;
  items.forEach((it, i) => {
    if (it.kind === 'user') {
      open = { kind: 'run', key: `run-${it.seq ?? i}`, user: it, work: [] };
      out.push(open);
    } else if (open && it.kind === 'finished') {
      open.finished = it;
      // A run that ended with a plain answer shows that answer, not the work before it.
      const last = open.work.findLastIndex((w) => w.kind === 'assistant');
      if (it.reason === 'answered' && last >= 0) open.answer = (open.work.splice(last, 1)[0] as { text: string }).text;
      open = undefined;
    } else if (open) open.work.push(it);
    else out.push({ kind: 'note', key: `note-${i}`, item: it });
  });
  return out;
}

// One line for a finished run's work: what it did and what it cost.
function workSummary(work: TimelineItem[]): string {
  const tools = work.filter((w): w is ToolItem => w.kind === 'tool');
  const count = (names: string[]) => tools.filter((t) => names.includes(t.name)).length;
  const edited = new Set(tools.filter((t) => t.name === 'edit_file' || t.name === 'write_file').map((t) => String(t.input.path ?? ''))).size;
  const parts = [
    edited ? `edited ${edited} file${edited === 1 ? '' : 's'}` : '',
    count(['read_file']) ? `read ${count(['read_file'])}` : '',
    count(['bash']) ? `ran ${count(['bash'])} command${count(['bash']) === 1 ? '' : 's'}` : '',
    count(['check_page']) ? `${count(['check_page'])} page check${count(['check_page']) === 1 ? '' : 's'}` : '',
    count(['grep', 'list_files']) ? `${count(['grep', 'list_files'])} search${count(['grep', 'list_files']) === 1 ? '' : 'es'}` : '',
    work.some((w) => w.kind === 'helper') ? `${work.filter((w) => w.kind === 'helper').length} helper${work.filter((w) => w.kind === 'helper').length === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  const cost = work.reduce((n, w) => n + (w.kind === 'step' ? w.costUsd : 0), 0);
  const steps = work.filter((w) => w.kind === 'step').length;
  return [`${steps} step${steps === 1 ? '' : 's'}`, ...parts, cost ? (cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`) : ''].filter(Boolean).join(' · ');
}

export function Timeline({
  sessionId,
  items,
  live,
  running,
  onApprove,
  onOpenChanges,
  onRestore,
  onResume,
  onOpenMemory,
}: {
  sessionId: string;
  items: TimelineItem[];
  live: string;
  running: boolean;
  onApprove: (approvalId: string, allow: boolean) => void;
  onOpenChanges: () => void;
  onRestore: (turn: number, text: string) => void;
  onResume: (reason: string) => void;
  onOpenMemory: () => void;
}) {
  const segs = React.useMemo(() => segments(items), [items]);
  const lastFinished = [...items].reverse().find((i): i is FinishedItem => i.kind === 'finished');
  // Finished runs are folded to one line; these are the ones the user opened.
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((all) => {
      const next = new Set(all);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // A message OneRoute sent for the user (Resume / Retry) is a note, not a speech bubble.
  const renderUser = (it: UserItem, key: string) =>
    it.auto ? (
      <motion.div key={key} {...enter} className="text-muted-foreground mt-3 flex items-center gap-2 text-[12.5px]">
        <PlayIcon className="size-3.5" aria-hidden />
        {it.text.startsWith('The last step failed') ? 'Retried after the error' : 'Resumed after the restart'}
      </motion.div>
    ) : (
    <motion.div key={key} {...enter} className="group mt-3 flex flex-col items-end gap-1 self-end first:mt-0" style={{ maxWidth: '85%' }}>
      <div className="bg-muted rounded-[14px_14px_4px_14px] px-4 py-2.5 text-[15px] whitespace-pre-wrap shadow-[inset_0_0_0_1px_rgba(123,123,123,0.12)]">{it.text}</div>
      <div className="flex items-center gap-2">
        {it.checkpoint && it.seq && !it.restored && !running ? (
          <button
            type="button"
            onClick={() => onRestore(it.seq!, it.text)}
            title="Put the files back to how they were before this message"
            className="text-muted-foreground/70 hover:text-foreground flex cursor-pointer items-center gap-1 text-[11px] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <RotateCcwIcon className="size-3" aria-hidden />
            Restore files to here
          </button>
        ) : null}
        {it.mode ? (
          <span className="text-muted-foreground/60 text-[11px]">
            {it.mode} · {it.permission === 'auto' ? 'auto-edit' : it.permission}
            {it.checkpoint ? ` · ${it.checkpoint} file${it.checkpoint === 1 ? '' : 's'} changed` : ''}
          </span>
        ) : null}
      </div>
    </motion.div>
  );

  const renderFinished = (it: FinishedItem, key: string) => (
    <motion.div key={key} {...enter} className="rounded-lg border px-4 py-3.5">
      <div className={cn('flex items-center gap-2 text-[12px] font-medium', it.reason === 'finish' || it.reason === 'answered' ? 'text-good' : 'text-muted-foreground')}>
        {FINISH_LABEL[it.reason] ?? it.reason}
        {it.checks ? <span className={cn('font-normal', it.checks === 'passed' ? 'text-good/80' : 'text-bad')}>· checks {it.checks}</span> : null}
      </div>
      {it.summary ? (
        <div className="mt-1.5 [&_.prose-answer]:text-[14px]">
          <Answer text={unescape(it.summary)} />
        </div>
      ) : null}
      {it.verified ? <p className="text-muted-foreground mt-2 text-[13px] whitespace-pre-wrap">Verified: {unescape(it.verified)}</p> : null}
      {it.next_steps ? <p className="text-muted-foreground mt-1.5 text-[13px] whitespace-pre-wrap">Next: {unescape(it.next_steps)}</p> : null}
      {(it.reason === 'interrupted' || it.reason === 'error') && it === lastFinished && !running ? (
        <button type="button" onClick={() => onResume(it.reason)} className="mt-3 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-linear-to-b from-[#f7f7f7] to-white px-3 text-[12.5px] font-medium text-black active:scale-[0.97]">
          <PlayIcon className="size-3.5" aria-hidden />
          {it.reason === 'error' ? 'Retry' : 'Resume'}
        </button>
      ) : null}
    </motion.div>
  );

  // The work items of a run (tool cards, notes, the plan …).
  const renderWork = (work: TimelineItem[], keyBase: string) => {
    const lastTodo = work.findLastIndex((w) => w.kind === 'todo');
    return work.map((it, i) => {
      const key = `${keyBase}-${i}`;
      switch (it.kind) {
        case 'route':
          return (
            <motion.div key={key} {...enter} className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs" title={it.why.join('\n')}>
              <Chip>
                <SparklesIcon aria-hidden />
                {it.modelId.split('/')[1] ?? it.modelId}
              </Chip>
              <Chip tone="soft">{it.effort}</Chip>
              <span>{it.role}</span>
            </motion.div>
          );
        case 'assistant':
          return (
            <motion.div key={key} {...enter} className="px-0.5">
              <Answer text={it.text} />
            </motion.div>
          );
        case 'tool':
          return <ToolCard key={it.id} item={it} sessionId={sessionId} />;
        case 'helper':
          return <HelperCard key={it.id} item={it} sessionId={sessionId} />;
        case 'approval':
          return <ApprovalCard key={it.approvalId} item={it} onAnswer={(allow) => onApprove(it.approvalId, allow)} />;
        case 'todo':
          return i === lastTodo ? (
            <motion.div key={key} {...enter} className="rounded-lg border px-3.5 py-3">
              <div className="text-muted-foreground mb-2 flex items-center gap-2 text-[12px] font-medium">
                <ListTodoIcon className="size-3.5" aria-hidden />
                Plan
              </div>
              <ul className="flex flex-col gap-1.5 text-[13px]">
                {it.items.map((t, j) => (
                  <li key={j} className={cn('flex items-start gap-2', t.status === 'done' && 'text-muted-foreground line-through decoration-white/20')}>
                    {t.status === 'done' ? <CheckCircle2Icon className="text-good/80 mt-0.5 size-3.5 shrink-0" /> : t.status === 'in_progress' ? <CircleDashedIcon className="text-arc mt-0.5 size-3.5 shrink-0 animate-spin [animation-duration:3s]" /> : <CircleIcon className="text-muted-foreground/50 mt-0.5 size-3.5 shrink-0" />}
                    {t.text}
                  </li>
                ))}
              </ul>
            </motion.div>
          ) : null;
        case 'diff':
          if (!it.files.length) return null;
          return (
            <motion.button key={key} {...enter} type="button" onClick={onOpenChanges} className="text-muted-foreground hover:text-foreground cursor-pointer self-start text-[12px] transition-colors">
              {it.files.length} file{it.files.length === 1 ? '' : 's'} changed · view changes
            </motion.button>
          );
        case 'retry':
          return (
            <motion.div key={key} {...enter} className="text-warn/90 flex items-start gap-2 text-[12.5px]">
              <RotateCcwIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                The connection to the model dropped ({it.message}).{' '}
                {it.switchedTo ? `Switched to ${it.switchedTo.split('/')[1] ?? it.switchedTo} and trying again.` : `Trying again (${it.attempt} of ${it.of}).`}
              </span>
            </motion.div>
          );
        case 'verifying':
          return (
            <motion.div key={key} {...enter} className="text-muted-foreground flex items-center gap-2 text-[12.5px]">
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
              Running checks: {it.checks.join(', ')}…
            </motion.div>
          );
        case 'verification':
          return <VerificationCard key={key} item={it} sessionId={sessionId} />;
        case 'compacted':
          return (
            <motion.div key={key} {...enter} className="text-muted-foreground/70 flex items-center gap-2 text-[12px]">
              <ArchiveIcon className="size-3.5" aria-hidden />
              {it.how === 'summarized' ? `Compacted the conversation: summarised ${it.detail} earlier messages to save context.` : 'Cleared old tool output to save context.'}
            </motion.div>
          );
        default:
          return renderNote(it, key);
      }
    });
  };

  // Things that stay visible even when a run is folded.
  const renderNote = (it: TimelineItem, key: string) => {
    switch (it.kind) {
      case 'error':
        return (
          <motion.div key={key} {...enter}>
            <ErrorBox>{it.message}</ErrorBox>
          </motion.div>
        );
      case 'saved':
        return (
          <motion.div key={key} {...enter} className="text-muted-foreground flex items-center gap-2 text-[12.5px]">
            <GitBranchIcon className="size-3.5" aria-hidden />
            Saved to <code className="font-mono text-[12px]">{it.branch}</code> ({it.commit})
          </motion.div>
        );
      case 'undone':
        return (
          <motion.div key={key} {...enter} className="text-muted-foreground text-[12.5px]">
            Undid this session’s changes ({it.files} file{it.files === 1 ? '' : 's'} restored).
          </motion.div>
        );
      case 'restored':
        return (
          <motion.div key={key} {...enter} className="text-muted-foreground flex items-center gap-2 text-[12.5px]">
            <RotateCcwIcon className="size-3.5" aria-hidden />
            Restored the files ({it.files} file{it.files === 1 ? '' : 's'} put back).
          </motion.div>
        );
      case 'finished':
        return renderFinished(it, key);
      case 'memory':
        return (
          <motion.div key={key} {...enter} className="text-muted-foreground flex items-start gap-2 text-[12.5px]">
            <BrainIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {it.added.length ? <>Remembered for this project: {it.added.map((m) => `“${m.text}”`).join(' ')} </> : null}
              {it.removed.length ? <>Forgot: {it.removed.map((t) => `“${t}”`).join(' ')} </> : null}
              <button type="button" onClick={onOpenMemory} className="hover:text-foreground cursor-pointer underline decoration-white/20 underline-offset-2">
                Edit memory
              </button>
            </span>
          </motion.div>
        );
      default:
        return null;
    }
  };

  const lastRun = segs.findLastIndex((s) => s.kind === 'run');
  return (
    <div className="flex flex-col gap-2.5">
      {segs.map((seg, si) => {
        if (seg.kind === 'note') return renderNote(seg.item, seg.key);
        const done = Boolean(seg.finished);
        const open = !done || expanded.has(seg.key);
        const errors = seg.work.filter((w) => w.kind === 'error');
        const hasWork = seg.work.some((w) => w.kind !== 'error');
        return (
          <React.Fragment key={seg.key}>
            {renderUser(seg.user, `${seg.key}-user`)}
            {done && hasWork ? (
              <motion.button
                {...enter}
                type="button"
                onClick={() => toggle(seg.key)}
                aria-expanded={open}
                className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 self-start text-[12.5px] transition-colors"
              >
                <ChevronRightIcon className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')} aria-hidden />
                {open ? 'Hide the work' : `Worked · ${workSummary(seg.work)}`}
              </motion.button>
            ) : null}
            <AnimatePresence initial={false}>
              {open && hasWork ? (
                <motion.div
                  key={`${seg.key}-work`}
                  initial={done ? { height: 0, opacity: 0 } : false}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
                  className={cn('flex flex-col gap-2.5', done && 'overflow-hidden border-l pl-3.5')}
                >
                  {renderWork(
                    seg.work.filter((w) => w.kind !== 'error' || !done),
                    seg.key,
                  )}
                </motion.div>
              ) : null}
            </AnimatePresence>
            {done ? errors.map((e, i) => renderNote(e, `${seg.key}-err-${i}`)) : null}
            {seg.answer ? (
              <motion.div {...enter} className="px-0.5">
                <Answer text={seg.answer} />
              </motion.div>
            ) : null}
            {seg.finished && !(seg.finished.reason === 'answered' && seg.answer) ? renderFinished(seg.finished, `${seg.key}-finished`) : null}
            {si === lastRun && !done ? (
              live ? (
                <div className="px-0.5">
                  <Answer text={live} />
                </div>
              ) : running ? (
                <span className="shimmer-text px-0.5 text-[14px]">Working…</span>
              ) : null
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}
