import { AnimatePresence, motion } from 'framer-motion';
import {
  BrainIcon,
  ExternalLinkIcon,
  FolderGitIcon,
  FolderPlusIcon,
  GitBranchIcon,
  InfoIcon,
  ListChecksIcon,
  Loader2Icon,
  PlayIcon,
  PencilLineIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  ScrollTextIcon,
  SquareIcon,
  TerminalIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import * as React from 'react';
import { Chip, SectionLabel } from '@/components/chip';
import {
  AiPromptInput,
  type AiModel,
  type AiPromptActiveTool,
  PromptMenuItem,
  PromptMenuLabel,
  PromptMenuSeparator,
} from '@/components/ui/ai-prompt-input';
import { storage } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { type CodeEvent, type CodeProject, type CodeSession, type DiffFile, type Mode, type Permission, type ProcessInfo, codeApi, followSession } from './api';
import { FolderPicker } from './folder-picker';
import { ArcBackdrop } from '@/components/arc-backdrop';
import { FolderSwitcher } from './folder-switcher';
import { CodeHome } from './home';
import { MemoryPanel } from './memory';
import { CodeSidebar } from './sidebar';
import { buildTimeline, Timeline } from './timeline';

const MODES: AiModel[] = [
  { id: 'cheap', label: 'Cheap', description: 'Works in small increments and pauses after each, so you steer and spend little.' },
  { id: 'balanced', label: 'Balanced', description: 'Keeps going until the task is done and verified, trading quality against cost.' },
  { id: 'best', label: 'Best', description: 'Keeps going until done, with the strongest models and more reasoning.' },
];

const PERMISSIONS: [Permission, string, string][] = [
  ['auto', 'Auto-edit', 'Edits and ordinary commands run; dangerous ones ask'],
  ['ask', 'Ask', 'Every edit and command asks first'],
  ['plan', 'Plan', 'Read-only: investigates and proposes a plan'],
];

const PLACEHOLDERS = ['Describe what to build…', 'Fix the failing test in…', 'Add a dark mode toggle…', 'Refactor the auth module…', 'Explain how this project works…'];

// A system notification when a run waits for approval while the app isn't in view (the approval card is in the app).
function askNotificationPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission().catch(() => {});
}
function notifyApproval(what: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || (document.visibilityState === 'visible' && document.hasFocus())) return;
  const n = new Notification('OneRoute Code needs your approval', { body: `The agent wants to run ${what}. Open OneRoute to allow or deny it.`, tag: 'oneroute-approval' });
  n.onclick = () => {
    window.focus();
    n.close();
  };
}

const usd = (v: number) => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="bg-muted mx-2.5 mt-0.5 mb-1.5 flex gap-0.5 rounded-[10px] p-[3px]">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            // 7px inside the 10px track with 3px padding, so the corners run parallel.
            'flex-1 cursor-pointer rounded-[7px] py-1 text-xs font-medium transition-colors duration-150',
            value === v ? 'bg-popover text-foreground shadow-[inset_0_0_0_1px_rgba(123,123,123,0.12)]' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Changes: per-file unified diff

function DiffView({ files, patch }: { files: DiffFile[]; patch: string }) {
  const chunks = React.useMemo(() => {
    const out = new Map<string, string[]>();
    for (const block of patch.split(/^diff --git /m).slice(1)) {
      const lines = block.split('\n');
      const path = /^a\/(.+?) b\/(.+)$/.exec(lines[0] ?? '')?.[2] ?? lines[0] ?? '';
      out.set(path, lines.slice(lines.findIndex((l) => l.startsWith('@@'))));
    }
    return out;
  }, [patch]);
  const [open, setOpen] = React.useState<string | null>(null);
  if (!files.length) return <p className="text-muted-foreground px-1 text-[13px]">No changes yet.</p>;
  return (
    <div className="flex flex-col gap-2">
      {files.map((f) => {
        const lines = chunks.get(f.path) ?? [];
        const isOpen = open === f.path;
        return (
          <div key={f.path} className="overflow-hidden rounded-lg border">
            <button type="button" onClick={() => setOpen(isOpen ? null : f.path)} className="hover:bg-muted/40 flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors">
              <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
              {f.status === 'added' ? <Chip tone="soft">new</Chip> : f.status === 'deleted' ? <Chip tone="soft">deleted</Chip> : null}
              <span className="text-good font-mono text-[11.5px]">+{f.added}</span>
              <span className="text-bad font-mono text-[11.5px]">−{f.removed}</span>
            </button>
            {isOpen ? (
              <pre className="max-h-[60vh] overflow-auto border-t font-mono text-[11.5px] leading-[1.55]">
                {lines.map((l, i) => (
                  <div
                    key={i}
                    className={cn(
                      'px-3 whitespace-pre',
                      l.startsWith('+') && 'bg-good/10 text-good',
                      l.startsWith('-') && 'bg-bad/10 text-bad',
                      l.startsWith('@@') && 'text-arc/80 bg-white/[0.02]',
                      !/^[+\-@]/.test(l) && 'text-muted-foreground',
                    )}
                  >
                    {l || ' '}
                  </div>
                ))}
              </pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------

export function CodeWorkspace({
  sidebarOpen,
  panelOpen,
  mode,
  onModeChange,
  onCloseSidebar,
}: {
  sidebarOpen: boolean;
  panelOpen: boolean;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onCloseSidebar: () => void;
}) {
  const [projects, setProjects] = React.useState<CodeProject[]>([]);
  const [sessions, setSessions] = React.useState<CodeSession[]>([]);
  const [projectId, setProjectId] = React.useState<string | undefined>(() => storage.get<string | undefined>('code.project', undefined));
  const [sessionId, setSessionId] = React.useState<string | undefined>(() => storage.get<string | undefined>('code.session', undefined));
  const [permission, setPermission] = React.useState<Permission>(() => storage.get<Permission>('code.permission', 'auto'));
  const [events, setEvents] = React.useState<CodeEvent[]>([]);
  const [live, setLive] = React.useState('');
  const [running, setRunning] = React.useState(false);
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState('');
  const [pickerOpen, setPickerOpen] = React.useState(false);
  // Where new sessions work: directly in the folder (default), or on a separate git branch in their own copy.
  const [isolated, setIsolated] = React.useState(() => storage.get('code.isolated', false));
  React.useEffect(() => storage.set('code.isolated', isolated), [isolated]);
  const [tab, setTab] = React.useState<'changes' | 'terminal' | 'run' | 'memory' | 'details'>('changes');
  const [memoryKey, setMemoryKey] = React.useState(0);
  const [processes, setProcesses] = React.useState<ProcessInfo[]>([]);
  const [previewing, setPreviewing] = React.useState(false);
  const [previewUrl, setPreviewUrl] = React.useState<string>();
  const [diff, setDiff] = React.useState<{ files: DiffFile[]; patch: string }>({ files: [], patch: '' });
  const scroller = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => storage.set('code.project', projectId), [projectId]);
  React.useEffect(() => storage.set('code.session', sessionId), [sessionId]);
  React.useEffect(() => storage.set('code.permission', permission), [permission]);

  const refresh = React.useCallback(async () => {
    try {
      const [p, s] = await Promise.all([codeApi.projects(), codeApi.sessions()]);
      setProjects(p);
      setSessions(s);
      // Remembered folder or session may have been removed since.
      setProjectId((cur) => (cur && p.some((x) => x.id === cur) ? cur : p[0]?.id));
      setSessionId((cur) => (cur && s.some((x) => x.id === cur) ? cur : undefined));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const session = sessions.find((s) => s.id === sessionId);
  const project = projects.find((p) => p.id === (session?.projectId ?? projectId));

  const loadDiff = React.useCallback(async (id: string) => {
    try {
      setDiff(await codeApi.diff(id));
    } catch {
      setDiff({ files: [], patch: '' });
    }
  }, []);

  const loadProcesses = React.useCallback(async (id: string) => {
    try {
      setProcesses(await codeApi.processes(id));
    } catch {
      setProcesses([]);
    }
  }, []);

  // Follow the open session's timeline.
  React.useEffect(() => {
    setProcesses([]);
    setPreviewUrl(undefined);
    if (sessionId) void loadProcesses(sessionId);
    setEvents([]);
    setLive('');
    setRunning(false);
    setDiff({ files: [], patch: '' });
    if (!sessionId) return;
    void loadDiff(sessionId);
    const nearBottom = () => {
      const el = scroller.current;
      return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    let caughtUp = false;
    const toBottom = () => requestAnimationFrame(() => scroller.current && (scroller.current.scrollTop = scroller.current.scrollHeight));
    const stop = followSession(
      sessionId,
      (e) => {
        const stick = nearBottom();
        if (e.type === 'text_delta') setLive((t) => t + String(e.data.text ?? ''));
        else if (e.type === 'thinking') return;
        else if (e.type === 'process') {
          void loadProcesses(sessionId);
          return;
        }
        else {
          if (['assistant', 'tool_call', 'finished', 'error', 'retry'].includes(e.type)) setLive('');
          if (e.type === 'user') setRunning(true);
          if (e.type === 'memory') setMemoryKey((k) => k + 1);
          // Only for new approvals, not ones replayed from the stored timeline when the session opens.
          if (e.type === 'approval_required' && caughtUp) notifyApproval(String(e.data.name ?? 'a command'));
          if (e.type === 'finished') {
            setRunning(false);
            void refresh();
          }
          if (['diff', 'finished', 'saved', 'restored', 'undone'].includes(e.type)) void loadDiff(sessionId);
          setEvents((all) => (e.seq && all.some((x) => x.seq === e.seq) ? all : [...all, e]));
        }
        if (stick) toBottom();
      },
      (isRunning) => {
        caughtUp = true;
        setRunning(isRunning);
        toBottom();
      },
    );
    return stop;
  }, [sessionId, loadDiff, loadProcesses, refresh]);

  // Runs the project and opens it in a new tab. The tab is opened right away (browsers block pop-ups that open
  // after a wait) and pointed at the app once it is up.
  const preview = async (id: string) => {
    const win = window.open('', '_blank');
    win?.document.write('<title>Starting preview…</title><body style="background:#0e0e10;color:#999;font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0">Starting the preview…</body>');
    setPreviewing(true);
    setError('');
    try {
      const r = await codeApi.preview(id);
      void loadProcesses(id);
      if (r.url) {
        setPreviewUrl(r.url);
        if (win) win.location.href = r.url;
        else window.open(r.url, '_blank');
      } else {
        win?.close();
        setTab('run');
        setError('The dev server is starting but hasn’t shown its address yet. Its output is in the Run tab.');
      }
    } catch (err) {
      win?.close();
      setTab('run');
      setError((err as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const items = React.useMemo(() => buildTimeline(events), [events]);
  const terminal = items.filter((i) => i.kind === 'tool' && i.name === 'bash');
  const steps = events.filter((e) => e.type === 'step');
  const routes = items.filter((i) => i.kind === 'route');
  const runCost = steps.reduce((n, e) => n + Number(e.data.costUsd ?? 0), 0);

  const submit = async (text: string) => {
    if (!text.trim()) return;
    setError('');
    askNotificationPermission();
    try {
      if (session) {
        await codeApi.message(session.id, text, mode, permission);
      } else {
        if (!project) {
          setError('Add a project folder first.');
          return;
        }
        const s = await codeApi.start(project.id, text, mode, permission, isolated);
        setSessions((all) => [s, ...all]);
        setSessionId(s.id);
      }
      setValue('');
      setRunning(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Opening a folder uses Finder's own chooser (with New Folder), like other coding agents; the in-app picker is
  // only the fallback where that isn't available.
  const [choosing, setChoosing] = React.useState(false);
  const openFolder = async () => {
    if (choosing) return;
    setError('');
    setChoosing(true);
    try {
      const path = await codeApi.chooseFolder();
      if (path) await addProject(path);
    } catch (err) {
      if ((err as Error).message === 'unsupported') setPickerOpen(true);
      else setError((err as Error).message);
    } finally {
      setChoosing(false);
    }
  };

  // Throws so the folder picker can show the problem.
  const addProject = async (path: string) => {
    const p = await codeApi.addProject(path);
    setPickerOpen(false);
    setProjectId(p.id);
    setSessionId(undefined);
    void refresh();
  };

  const action = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const activeTools: AiPromptActiveTool[] = [];
  if (permission !== 'auto') {
    const [, label] = PERMISSIONS.find(([p]) => p === permission)!;
    activeTools.push({ key: 'perm', label: `${label} mode`, icon: permission === 'plan' ? <ScrollTextIcon aria-hidden /> : <PencilLineIcon aria-hidden />, onRemove: () => setPermission('auto') });
  }

  return (
    <div className="flex min-h-0 max-lg:flex-col">
      <FolderPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={addProject} />
      {/* Projects, each with its sessions */}
      <CodeSidebar
        open={sidebarOpen}
        projects={projects}
        sessions={sessions}
        projectId={projectId}
        sessionId={sessionId}
        onClose={onCloseSidebar}
        onNewSession={(id) => {
          if (id) setProjectId(id);
          setSessionId(undefined);
        }}
        onOpenFolder={() => void openFolder()}
        onSelectProject={(id) => {
          setProjectId(id);
          setSessionId(undefined);
        }}
        onOpenSession={setSessionId}
        onRenameSession={(id, title) =>
          void action(async () => {
            setSessions((all) => all.map((x) => (x.id === id ? { ...x, title } : x)));
            await codeApi.rename(id, title);
          })
        }
        onDeleteSession={(s) =>
          void action(async () => {
            await codeApi.discard(s.id);
            if (s.id === sessionId) setSessionId(undefined);
            await refresh();
          })
        }
        onRemoveProject={(id) =>
          void action(async () => {
            await codeApi.removeProject(id);
            if (id === project?.id) setSessionId(undefined);
            await refresh();
          })
        }
      />

      {/* The run */}
      <section className="relative grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] overflow-hidden">
        <div className="flex min-h-12 items-center gap-2 border-b px-5 py-2">
          {session ? (
            <>
              <span className="min-w-0 truncate text-[14px] font-medium">{session.title}</span>
              <Chip tone="soft" className="max-w-56 shrink-0 overflow-hidden" title={session.inPlace ? session.worktree : session.branch}>
                {session.inPlace ? <FolderGitIcon aria-hidden /> : <GitBranchIcon aria-hidden />}
                <span className="truncate">{session.inPlace ? (project?.name ?? 'folder') + (session.branch ? ` · ${session.branch}` : '') : session.branch}</span>
              </Chip>
              <span className="text-muted-foreground shrink-0 text-[12px] tabular-nums">{usd(session.costUsd)}</span>
              <div className="flex-1" />
              <HeaderButton onClick={() => void preview(session.id)} icon={previewing ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}>
                Preview
              </HeaderButton>
              {running ? (
                <HeaderButton onClick={() => void action(() => codeApi.stop(session.id))} icon={<SquareIcon className="fill-current" />}>
                  Stop
                </HeaderButton>
              ) : null}
              {session.inPlace ? (
                <>
                  <HeaderButton
                    onClick={() =>
                      void action(async () => {
                        if (!window.confirm('Undo every change this session made to your files? Files it created are deleted and edited files are restored.')) return;
                        await codeApi.undo(session.id);
                      })
                    }
                    icon={<RotateCcwIcon />}
                  >
                    Undo changes
                  </HeaderButton>
                  <HeaderButton
                    onClick={() =>
                      void action(async () => {
                        if (!window.confirm(`Remove "${session.title}" from the list? Your files stay as they are.`)) return;
                        await codeApi.discard(session.id);
                        setSessionId(undefined);
                        void refresh();
                      })
                    }
                    icon={<Trash2Icon />}
                  >
                    Remove
                  </HeaderButton>
                </>
              ) : (
                <>
                  <HeaderButton onClick={() => void action(async () => (await codeApi.save(session.id)).commit ?? setError('Nothing new to save.'))} icon={<SaveIcon />}>
                    Save to branch
                  </HeaderButton>
                  <HeaderButton
                    onClick={() =>
                      void action(async () => {
                        if (!window.confirm(`Discard "${session.title}"? This deletes its separate copy and branch ${session.branch}.`)) return;
                        await codeApi.discard(session.id);
                        setSessionId(undefined);
                        void refresh();
                      })
                    }
                    icon={<Trash2Icon />}
                  >
                    Discard
                  </HeaderButton>
                </>
              )}
            </>
          ) : (
            <span className="text-muted-foreground text-[13.5px]">{project ? <>New session in <span className="text-foreground">{project.name}</span></> : 'No project selected'}</span>
          )}
        </div>

        <AnimatePresence>{!session ? <ArcBackdrop key="arc" variant="code" className="top-12" /> : null}</AnimatePresence>
        {/* A new session's start screen is fitted to the space and never scrolls; a session's timeline does. */}
        <div ref={scroller} className={cn('relative min-h-0 px-6 py-6 max-lg:px-4', session ? 'overflow-y-auto' : 'overflow-hidden')}>
          <div className={cn('mx-auto max-w-220', !session && 'h-full')}>
            {session ? (
              <Timeline
                sessionId={session.id}
                items={items}
                live={live}
                running={running}
                onApprove={(approvalId, allow) => void action(() => codeApi.approve(session.id, approvalId, allow))}
                onOpenChanges={() => setTab('changes')}
                onOpenMemory={() => setTab('memory')}
                onResume={() => void action(() => codeApi.resume(session.id, mode, permission).then(() => setRunning(true)))}
                onRestore={(turn, text) =>
                  void action(async () => {
                    const short = text.length > 80 ? `${text.slice(0, 79)}…` : text;
                    if (!window.confirm(`Put the files back to how they were before “${short}”? Changes from that message on are undone; the conversation stays.`)) return;
                    await codeApi.restore(session.id, turn);
                  })
                }
              />
            ) : (
              <CodeHome
                project={project}
                isolated={isolated}
                onOpenFolder={() => void openFolder()}
                onStarter={(prompt) => {
                  setValue(prompt);
                  requestAnimationFrame(() => {
                    const el = inputRef.current;
                    el?.focus();
                    el?.setSelectionRange(prompt.length, prompt.length);
                  });
                }}
              />
            )}
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-240 px-5 pt-2 pb-4 max-lg:px-3">
          {choosing ? (
            <div role="status" className="text-muted-foreground mb-2 px-1 text-[12.5px]">
              Choose a folder in the Finder window…
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="text-bad mb-2 px-1 text-[12.5px]">
              {error}
            </div>
          ) : null}
          <AiPromptInput
            ref={inputRef}
            density="compact"
            // A darker, nearly black box than Chat's.
            className="dark:bg-[#0f0f0f]"
            value={value}
            onChange={setValue}
            onSubmit={(t) => void submit(t)}
            status={running ? 'loading' : 'idle'}
            placeholders={PLACEHOLDERS}
            models={MODES}
            modelSelection={{ id: mode }}
            onModelSelectionChange={(s) => onModeChange(s.id as Mode)}
            activeTools={activeTools}
            showMic={false}
            showVoice={false}
            maxLength={20000}
            aria-label="Describe the task"
            toolbarStart={
              <FolderSwitcher
                projects={projects}
                currentId={project?.id}
                onSelect={(id) => {
                  setProjectId(id);
                  setSessionId(undefined);
                }}
                onOpenFolder={() => void openFolder()}
              />
            }
            actionsMenu={(close) => (
              // Fixed width: the permission description changes length and must not resize the menu.
              <div className="flex w-68 flex-col gap-0.5">
                <PromptMenuItem
                  icon={<FolderPlusIcon />}
                  label="Open folder…"
                  description={project ? `Current: ${project.name}` : 'Choose the folder to work in'}
                  onSelect={() => {
                    close();
                    void openFolder();
                  }}
                />
                <PromptMenuSeparator />
                {!session ? (
                  <>
                    <PromptMenuLabel>Works in</PromptMenuLabel>
                    <Segmented
                      value={isolated ? 'branch' : 'folder'}
                      options={[
                        ['folder', 'This folder'],
                        ['branch', 'Separate branch'],
                      ]}
                      onChange={(v) => setIsolated(v === 'branch')}
                    />
                    <PromptMenuSeparator />
                  </>
                ) : null}
                <PromptMenuLabel>Permissions</PromptMenuLabel>
                <Segmented value={permission} options={PERMISSIONS.map(([p, l]) => [p, l])} onChange={setPermission} />
                <p className="text-muted-foreground/70 min-h-[calc(2lh+6px)] px-2.5 pb-1.5 text-[11.5px]">{PERMISSIONS.find(([p]) => p === permission)![2]}</p>
                <PromptMenuSeparator />
                <PromptMenuItem
                  icon={<PlusIcon />}
                  label="New session"
                  onSelect={() => {
                    close();
                    setSessionId(undefined);
                  }}
                />
              </div>
            )}
          />
          <div className="text-muted-foreground/70 mt-1.5 text-center text-[11px]">
            {mode === 'cheap' ? 'Cheap: works in small increments and pauses after each' : 'Keeps going until the task is done'} · dangerous commands always ask
          </div>
        </div>
      </section>

      {/* Changes, terminal, run details */}
      <AnimatePresence initial={false}>
        {panelOpen && session ? (
          <motion.aside
            key="code-panel"
            aria-label="Changes and details"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 460, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
            className="min-h-0 shrink-0 overflow-hidden border-l max-lg:hidden"
          >
            <div className="flex h-full w-[460px] flex-col">
              <div className="flex gap-0.5 overflow-x-auto border-b px-2.5 py-2 [scrollbar-width:none]">
                {(
                  [
                    ['changes', 'Changes', <ListChecksIcon key="c" />, diff.files.length || undefined],
                    ['terminal', 'Terminal', <TerminalIcon key="t" />, terminal.length || undefined],
                    ['run', 'Run', <PlayIcon key="r" />, processes.filter((p) => p.status === 'running').length || undefined],
                    ['memory', 'Memory', <BrainIcon key="m" />, undefined],
                    ['details', 'Details', <InfoIcon key="d" />, undefined],
                  ] as const
                ).map(([id, label, icon, count]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={cn(
                      'flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] font-medium transition-colors [&_svg]:size-3.5',
                      tab === id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {icon}
                    {label}
                    {count ? <span className="text-muted-foreground/70 tabular-nums">{count}</span> : null}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {tab === 'changes' ? (
                  <DiffView files={diff.files} patch={diff.patch} />
                ) : tab === 'terminal' ? (
                  terminal.length ? (
                    <div className="flex flex-col gap-3">
                      {terminal.map((t) =>
                        t.kind === 'tool' ? (
                          <div key={t.id} className="overflow-hidden rounded-lg border">
                            <div className="border-b bg-white/[0.02] px-3 py-1.5 font-mono text-[12px]">$ {String(t.input.command ?? '')}</div>
                            <pre className="text-muted-foreground max-h-72 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">{t.result?.output ?? 'Running…'}</pre>
                          </div>
                        ) : null,
                      )}
                    </div>
                  ) : (
                    <p className="text-muted-foreground px-1 text-[13px]">No commands yet.</p>
                  )
                ) : tab === 'memory' ? (
                  project ? <MemoryPanel projectId={project.id} projectName={project.name} refreshKey={memoryKey} /> : null
                ) : tab === 'run' ? (
                  <RunPanel
                    sessionId={session.id}
                    processes={processes}
                    previewing={previewing}
                    previewUrl={previewUrl}
                    onPreview={() => void preview(session.id)}
                    onStop={(pid) => void action(async () => (await codeApi.stopProcess(session.id, pid), loadProcesses(session.id)))}
                    onClear={() => void action(async () => (await codeApi.clearProcesses(session.id), loadProcesses(session.id)))}
                  />
                ) : (
                  <div className="flex flex-col gap-3 text-[13px]">
                    <div className="grid grid-cols-2 gap-1.5">
                      <Stat k="Steps" v={String(steps.length)} />
                      <Stat k="Cost so far" v={usd(runCost)} />
                    </div>
                    {routes.map((r, i) =>
                      r.kind === 'route' ? (
                        <div key={i} className="rounded-lg border p-3">
                          <SectionLabel className="mb-1.5">{r.role}</SectionLabel>
                          <div className="font-medium">
                            {r.modelId} <Chip tone="soft">{r.effort}</Chip>
                          </div>
                          <ul className="text-muted-foreground mt-2 flex flex-col gap-1 text-[12.5px] leading-relaxed">
                            {r.why.map((w, j) => (
                              <li key={j}>{w}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null,
                    )}
                    {project ? (
                      <p className="text-muted-foreground/70 text-[11.5px] break-all">
                        {session.inPlace ? 'Folder' : 'Separate copy'}: <span className="font-mono">{session.worktree}</span>
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// Running processes (dev servers, watchers) with their output, and the Preview button.
function RunPanel({
  sessionId,
  processes,
  previewing,
  previewUrl,
  onPreview,
  onStop,
  onClear,
}: {
  sessionId: string;
  processes: ProcessInfo[];
  previewing: boolean;
  previewUrl?: string;
  onPreview: () => void;
  onStop: (pid: string) => void;
  onClear: () => void;
}) {
  const [selected, setSelected] = React.useState<string>();
  const [output, setOutput] = React.useState('');
  const current = processes.find((p) => p.id === selected) ?? processes.find((p) => p.status === 'running') ?? processes.at(-1);
  const pre = React.useRef<HTMLPreElement>(null);
  React.useEffect(() => {
    setOutput('');
    if (!current) return;
    let cancelled = false;
    const load = async () => {
      const text = await codeApi.processOutput(sessionId, current.id);
      if (cancelled) return;
      const el = pre.current;
      const stick = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      setOutput(text);
      if (stick) requestAnimationFrame(() => pre.current && (pre.current.scrollTop = pre.current.scrollHeight));
    };
    void load();
    const timer = current.status === 'running' ? setInterval(() => void load(), 1500) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, current?.id, current?.status]);

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <div className="rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-medium">Preview</div>
            <p className="text-muted-foreground mt-0.5 text-[12px]">Runs the project’s dev server if it has one, otherwise serves the folder, and opens it in a new tab.</p>
            {previewUrl ? (
              <a href={previewUrl} target="_blank" rel="noreferrer" className="text-arc hover:text-foreground mt-1.5 inline-flex items-center gap-1 text-[12px]">
                {previewUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                <ExternalLinkIcon className="size-3" aria-hidden />
              </a>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onPreview}
            disabled={previewing}
            className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-linear-to-b from-[#f7f7f7] to-white px-3 text-[12.5px] font-medium text-black active:scale-[0.97] disabled:opacity-60 [&_svg]:size-3.5"
          >
            {previewing ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
            Open
          </button>
        </div>
      </div>
      {processes.length ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between px-1">
            <SectionLabel>Processes</SectionLabel>
            {processes.some((p) => p.status === 'exited') ? (
              <button type="button" onClick={onClear} className="text-muted-foreground hover:text-foreground cursor-pointer text-[11.5px]">
                Clear finished
              </button>
            ) : null}
          </div>
          {processes.map((p) => (
            <div
              key={p.id}
              className={cn('flex items-center gap-2 rounded-lg border px-3 py-2', current?.id === p.id && 'bg-muted/50')}
            >
              <button type="button" onClick={() => setSelected(p.id)} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left">
                <span className={cn('size-1.5 shrink-0 rounded-full', p.status === 'running' ? 'bg-good animate-pulse' : p.exitCode ? 'bg-bad' : 'bg-muted-foreground/40')} />
                <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{p.command}</code>
              </button>
              {p.url ? (
                <a href={p.url} target="_blank" rel="noreferrer" className="text-arc hover:text-foreground flex shrink-0 items-center gap-1 text-[12px]">
                  {p.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                  <ExternalLinkIcon className="size-3" aria-hidden />
                </a>
              ) : null}
              {p.status === 'running' ? (
                <button type="button" aria-label={`Stop ${p.command}`} onClick={() => onStop(p.id)} className="text-muted-foreground hover:text-foreground flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md">
                  <SquareIcon className="size-3 fill-current" />
                </button>
              ) : (
                <span className="text-muted-foreground/70 shrink-0 text-[11px]">exit {p.exitCode ?? '?'}</span>
              )}
            </div>
          ))}
          {current ? (
            <pre ref={pre} className="text-muted-foreground mt-1 max-h-[46vh] overflow-auto rounded-lg border px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
              {output || 'No output yet.'}
            </pre>
          ) : null}
        </div>
      ) : (
        <p className="text-muted-foreground px-1 text-[12.5px]">No processes running. Dev servers the agent starts, and Preview’s, show up here with their output.</p>
      )}
    </div>
  );
}

function HeaderButton({ children, icon, onClick }: { children: React.ReactNode; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors active:scale-[0.97] [&_svg]:size-3.5"
    >
      {icon}
      {children}
    </button>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="bg-muted rounded-lg px-2.5 py-1.5 shadow-[inset_0_0_0_1px_rgba(123,123,123,0.12)]">
      <div className="text-muted-foreground/70 text-[10.5px] font-medium">{k}</div>
      <div className="text-sm font-semibold tabular-nums">{v}</div>
    </div>
  );
}
