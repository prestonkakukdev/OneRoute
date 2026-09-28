import { AnimatePresence, motion } from 'framer-motion';
import { CheckIcon, PencilIcon, SquarePenIcon, Trash2Icon, XIcon } from 'lucide-react';
import * as React from 'react';
import type { ChatSummary } from '@/lib/api';
import { cn } from '@/lib/utils';

// Today / Yesterday / Previous 7 days / Previous 30 days / Month Year, like other chat apps.
function groupLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

const ICON_BTN =
  'text-muted-foreground/70 hover:bg-accent hover:text-foreground flex size-6.5 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors duration-150 [&_svg]:size-3.5';

// A saved item with rename and delete in place (chats here, code sessions in Code mode).
export function SidebarItem({
  chat,
  active,
  leading,
  noun = 'chat',
  deleteHint,
  onOpen,
  onRename,
  onDelete,
}: {
  chat: { title: string };
  active: boolean;
  leading?: React.ReactNode;
  noun?: string;
  deleteHint?: string;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [mode, setMode] = React.useState<'view' | 'rename' | 'confirm'>('view');
  const [title, setTitle] = React.useState(chat.title);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (mode === 'rename') inputRef.current?.select();
  }, [mode]);

  const commit = () => {
    const next = title.trim();
    if (next && next !== chat.title) onRename(next);
    setMode('view');
  };

  return (
    <div
      className={cn(
        'group/chat relative flex items-center gap-1 rounded-xl pr-1 transition-colors duration-150',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      {mode === 'rename' ? (
        <input
          ref={inputRef}
          value={title}
          aria-label={`${noun[0]!.toUpperCase()}${noun.slice(1)} title`}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setTitle(chat.title);
              setMode('view');
            }
          }}
          className="bg-background text-foreground m-1 h-7 min-w-0 flex-1 rounded-lg border px-2 text-[13px] outline-none"
        />
      ) : (
        <button type="button" onClick={onOpen} title={chat.title} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 py-2 text-left text-[13px]">
          {leading}
          <span className="truncate">{chat.title}</span>
        </button>
      )}
      {mode === 'confirm' ? (
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={onDelete} title={deleteHint} className="text-bad hover:bg-bad/10 h-6.5 cursor-pointer rounded-lg px-2 text-xs font-medium">
            Delete
          </button>
          <button type="button" aria-label={`Keep ${noun}`} onClick={() => setMode('view')} className={ICON_BTN}>
            <XIcon aria-hidden />
          </button>
        </div>
      ) : mode === 'view' ? (
        <div className={cn('flex items-center opacity-0 transition-opacity group-hover/chat:opacity-100 focus-within:opacity-100', active && 'opacity-100')}>
          <button type="button" aria-label={`Rename ${chat.title}`} onClick={() => setMode('rename')} className={ICON_BTN}>
            <PencilIcon aria-hidden />
          </button>
          <button type="button" aria-label={`Delete ${chat.title}`} onClick={() => setMode('confirm')} className={ICON_BTN}>
            <Trash2Icon aria-hidden />
          </button>
        </div>
      ) : (
        <button type="button" aria-label="Save title" onMouseDown={(e) => e.preventDefault()} onClick={commit} className={ICON_BTN}>
          <CheckIcon aria-hidden />
        </button>
      )}
    </div>
  );
}

export function ChatSidebar({
  open,
  chats,
  activeId,
  error,
  onNew,
  onOpen,
  onRename,
  onDelete,
  onClose,
}: {
  onClose: () => void;
  open: boolean;
  chats: ChatSummary[];
  activeId: string;
  error?: string;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const groups = React.useMemo(() => {
    const out: { label: string; items: ChatSummary[] }[] = [];
    for (const c of chats) {
      const label = groupLabel(c.updatedAt);
      const last = out.at(-1);
      if (last?.label === label) last.items.push(c);
      else out.push({ label, items: [c] });
    }
    return out;
  }, [chats]);

  return (
    <AnimatePresence initial={false}>
      {open ? (
        // On narrow windows the list is a drawer over the chat, with a backdrop that closes it.
        <motion.div
          key="backdrop"
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        />
      ) : null}
      {open ? (
        <motion.nav
          key="chats"
          aria-label="Saved chats"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 264, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          className="bg-background min-h-0 shrink-0 overflow-hidden border-r max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-40 max-lg:shadow-2xl"
        >
          <div className="flex h-full w-66 flex-col">
            <div className="p-2.5">
              <button
                type="button"
                onClick={onNew}
                className="text-foreground hover:bg-muted flex h-9 w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 text-[13px] font-medium shadow-[inset_0_0_0_1px_var(--border)] transition-colors active:scale-[0.98]"
              >
                <SquarePenIcon className="size-4" aria-hidden />
                New chat
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
              {error ? <p className="text-bad px-2.5 py-2 text-xs">{error}</p> : null}
              {!chats.length && !error ? <p className="text-muted-foreground/70 px-2.5 py-2 text-xs">Chats you start are saved here.</p> : null}
              {groups.map((g) => (
                <div key={g.label} className="mt-3 first:mt-1">
                  <div className="text-muted-foreground/70 px-2.5 pb-1 text-[10px] font-semibold tracking-wide uppercase">{g.label}</div>
                  <div className="flex flex-col gap-0.5">
                    {g.items.map((c) => (
                      <SidebarItem
                        key={c.id}
                        chat={c}
                        active={c.id === activeId}
                        onOpen={() => onOpen(c.id)}
                        onRename={(t) => onRename(c.id, t)}
                        onDelete={() => onDelete(c.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.nav>
      ) : null}
    </AnimatePresence>
  );
}
