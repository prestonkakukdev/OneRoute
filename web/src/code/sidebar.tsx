import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRightIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon, PlusIcon, SquarePenIcon, XIcon } from 'lucide-react';
import * as React from 'react';
import { SidebarItem } from '@/components/chat-sidebar';
import { storage } from '@/lib/storage';
import { cn } from '@/lib/utils';
import type { CodeProject, CodeSession } from './api';

const ICON_BTN =
  'text-muted-foreground/70 hover:bg-accent hover:text-foreground flex size-6.5 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors duration-150 [&_svg]:size-3.5';

function ProjectGroup({
  project,
  sessions,
  current,
  activeSessionId,
  expanded,
  onToggle,
  onSelectProject,
  onNewSession,
  onOpenSession,
  onRenameSession,
  onDeleteSession,
  onRemoveProject,
}: {
  project: CodeProject;
  sessions: CodeSession[];
  current: boolean;
  activeSessionId?: string;
  expanded: boolean;
  onToggle: () => void;
  onSelectProject: () => void;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (s: CodeSession) => void;
  onRemoveProject: () => void;
}) {
  const [confirm, setConfirm] = React.useState(false);
  const Icon = expanded ? FolderOpenIcon : FolderIcon;
  return (
    <div>
      <div
        className={cn(
          'group/project flex items-center gap-1 rounded-lg pr-1 transition-colors duration-150',
          current && !activeSessionId ? 'bg-muted text-foreground' : 'text-foreground/85 hover:bg-muted/60',
        )}
      >
        <button
          type="button"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.name}`}
          aria-expanded={expanded}
          onClick={onToggle}
          className="text-muted-foreground/70 hover:text-foreground flex h-7 w-5 shrink-0 cursor-pointer items-center justify-end"
        >
          <ChevronRightIcon className={cn('size-3.5 transition-transform duration-150', expanded && 'rotate-90')} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => {
            onSelectProject();
            if (!expanded) onToggle();
          }}
          title={project.path}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pr-1 pl-1 text-left text-[13px] font-medium"
        >
          <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{project.name}</span>
          {!expanded && sessions.length ? <span className="text-muted-foreground/60 text-[11px] font-normal tabular-nums">{sessions.length}</span> : null}
        </button>
        {confirm ? (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => {
                setConfirm(false);
                onRemoveProject();
              }}
              title="Removes the project and its sessions from OneRoute. The folder and its files stay."
              className="text-bad hover:bg-bad/10 h-6.5 cursor-pointer rounded-lg px-2 text-xs font-medium"
            >
              Remove
            </button>
            <button type="button" aria-label="Keep project" onClick={() => setConfirm(false)} className={ICON_BTN}>
              <XIcon aria-hidden />
            </button>
          </div>
        ) : (
          <div className="flex items-center opacity-0 transition-opacity group-hover/project:opacity-100 focus-within:opacity-100">
            <button type="button" aria-label={`New session in ${project.name}`} title="New session" onClick={onNewSession} className={ICON_BTN}>
              <PlusIcon aria-hidden />
            </button>
            <button type="button" aria-label={`Remove ${project.name}`} title="Remove project" onClick={() => setConfirm(true)} className={ICON_BTN}>
              <XIcon aria-hidden />
            </button>
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="ml-3.5 flex flex-col gap-0.5 border-l py-0.5 pl-1.5">
              {sessions.map((s) => (
                <SidebarItem
                  key={s.id}
                  chat={s}
                  noun="session"
                  active={s.id === activeSessionId}
                  leading={<span className={cn('size-1.5 shrink-0 rounded-full', s.running ? 'bg-arc animate-pulse' : s.status === 'error' ? 'bg-bad' : s.status === 'interrupted' ? 'bg-warn' : 'bg-muted-foreground/35')} />}
                  deleteHint={s.inPlace ? 'Removes the session. Files in the folder stay as they are.' : `Deletes the session, its separate copy and branch ${s.branch}.`}
                  onOpen={() => onOpenSession(s.id)}
                  onRename={(t) => onRenameSession(s.id, t)}
                  onDelete={() => onDeleteSession(s)}
                />
              ))}
              {!sessions.length ? <p className="text-muted-foreground/60 px-2.5 py-1.5 text-xs">No sessions yet.</p> : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// Projects, each with its sessions underneath (newest first), like chats grouped by folder.
export function CodeSidebar({
  open,
  projects,
  sessions,
  projectId,
  sessionId,
  onClose,
  onNewSession,
  onOpenFolder,
  onSelectProject,
  onOpenSession,
  onRenameSession,
  onDeleteSession,
  onRemoveProject,
}: {
  open: boolean;
  projects: CodeProject[];
  sessions: CodeSession[];
  projectId?: string;
  sessionId?: string;
  onClose: () => void;
  onNewSession: (projectId?: string) => void;
  onOpenFolder: () => void;
  onSelectProject: (id: string) => void;
  onOpenSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (s: CodeSession) => void;
  onRemoveProject: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = React.useState<string[]>(() => storage.get<string[]>('code.collapsed', []));
  React.useEffect(() => storage.set('code.collapsed', collapsed), [collapsed]);
  const activeProject = sessions.find((s) => s.id === sessionId)?.projectId ?? projectId;

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div key="backdrop" className="fixed inset-0 z-30 bg-black/50 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      ) : null}
      {open ? (
        <motion.nav
          key="code-nav"
          aria-label="Projects and sessions"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 264, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          className="bg-background min-h-0 shrink-0 overflow-hidden border-r max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-40 max-lg:shadow-2xl"
        >
          <div className="flex h-full w-66 flex-col">
            <div className="flex gap-1.5 p-2.5">
              <button
                type="button"
                onClick={() => onNewSession()}
                className="text-foreground hover:bg-muted flex h-9 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium shadow-[inset_0_0_0_1px_var(--border)] transition-colors active:scale-[0.98]"
              >
                <SquarePenIcon className="size-4" aria-hidden />
                New session
              </button>
              <button
                type="button"
                aria-label="Open a folder"
                title="Open a folder"
                onClick={onOpenFolder}
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg shadow-[inset_0_0_0_1px_var(--border)] transition-colors active:scale-[0.96]"
              >
                <FolderPlusIcon className="size-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
              <div className="text-muted-foreground/70 px-2 pt-1 pb-1.5 text-[10px] font-semibold tracking-wide uppercase">Projects</div>
              {!projects.length ? <p className="text-muted-foreground/70 px-2 py-1 text-xs">Open a folder to start. Its sessions are listed under it.</p> : null}
              <div className="flex flex-col gap-1">
                {projects.map((p) => {
                  const expanded = !collapsed.includes(p.id);
                  return (
                    <ProjectGroup
                      key={p.id}
                      project={p}
                      sessions={sessions.filter((s) => s.projectId === p.id)}
                      current={p.id === activeProject}
                      activeSessionId={sessionId}
                      expanded={expanded}
                      onToggle={() => setCollapsed((all) => (expanded ? [...all.filter((x) => x !== p.id), p.id] : all.filter((x) => x !== p.id)))}
                      onSelectProject={() => onSelectProject(p.id)}
                      onNewSession={() => onNewSession(p.id)}
                      onOpenSession={onOpenSession}
                      onRenameSession={onRenameSession}
                      onDeleteSession={onDeleteSession}
                      onRemoveProject={() => onRemoveProject(p.id)}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </motion.nav>
      ) : null}
    </AnimatePresence>
  );
}
