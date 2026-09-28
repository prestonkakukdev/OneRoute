import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { CheckIcon, ChevronDownIcon, FolderIcon, FolderPlusIcon } from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import type { CodeProject } from './api';

// Motion matches the composer's model selector (Cheap / Balanced / Best), so the two controls feel like a pair.
const EASE = [0.2, 0, 0, 1] as const;
const SPRING_SOFT = { type: 'spring' as const, stiffness: 420, damping: 32 };
const SPRING_PRESS = { type: 'spring' as const, stiffness: 500, damping: 28 };
const SWAP = {
  initial: { opacity: 0, scale: 0.25, filter: 'blur(4px)' },
  animate: { opacity: 1, scale: 1, filter: 'blur(0px)' },
  exit: { opacity: 0, scale: 0.25, filter: 'blur(4px)' },
  transition: { type: 'spring' as const, duration: 0.3, bounce: 0 },
};
const FADE = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };
const list = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } };
const item = { hidden: { opacity: 0, y: 4 }, show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE } } };
const itemReduced = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0.15 } } };

// The current folder, shown in the composer like other coding agents show their working directory. Click to switch
// folders or open a new one.
export function FolderSwitcher({
  projects,
  currentId,
  onSelect,
  onOpenFolder,
  disabled,
}: {
  projects: CodeProject[];
  currentId?: string;
  onSelect: (id: string) => void;
  onOpenFolder: () => void;
  disabled?: boolean;
}) {
  const reduceMotion = Boolean(useReducedMotion());
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ left: number; bottom: number } | null>(null);
  const [hovered, setHovered] = React.useState<string | null>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const menu = React.useRef<HTMLDivElement>(null);
  const groupId = React.useId();
  const current = projects.find((p) => p.id === currentId);

  React.useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const update = () => {
      const r = trigger.current!.getBoundingClientRect();
      setPos({ left: r.left, bottom: window.innerHeight - r.top + 8 });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // No folders yet: the button opens the picker directly.
  const click = () => (projects.length ? setOpen((v) => !v) : onOpenFolder());
  const choose = (id: string) => {
    onSelect(id);
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <>
      <motion.button
        ref={trigger}
        type="button"
        disabled={disabled}
        onClick={click}
        aria-haspopup="menu"
        aria-expanded={open}
        title={current?.path ?? 'Open a folder'}
        whileHover={disabled ? undefined : { scale: 1.02, y: -1 }}
        whileTap={disabled ? undefined : { scale: 0.96 }}
        transition={SPRING_PRESS}
        className={cn(
          'text-muted-foreground flex h-9 max-w-48 cursor-pointer items-center gap-1.5 rounded-xl px-2.5 text-sm font-medium',
          'transition-[background-color,color,box-shadow,opacity] duration-200 ease-[cubic-bezier(0.2,0,0,1)]',
          'hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
          'disabled:pointer-events-none disabled:opacity-40',
          open && 'bg-muted text-foreground',
        )}
      >
        {/* The folder name swaps with the same blur-and-scale as the model name when it changes. */}
        <span className="relative flex min-w-0 items-center">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={current?.id ?? 'none'} {...(reduceMotion ? FADE : SWAP)} className="flex min-w-0 items-center gap-1.5">
              {current ? <FolderIcon className="size-4 shrink-0" aria-hidden /> : <FolderPlusIcon className="size-4 shrink-0" aria-hidden />}
              <span className={cn('truncate', current && 'text-foreground')}>{current?.name ?? 'Open folder'}</span>
            </motion.span>
          </AnimatePresence>
        </span>
        {projects.length ? (
          <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2, ease: EASE }} className="flex shrink-0">
            <ChevronDownIcon className="size-3.5 opacity-60" aria-hidden />
          </motion.span>
        ) : null}
      </motion.button>
      {createPortal(
        <AnimatePresence>
          {open && pos ? (
            <motion.div
              ref={menu}
              role="menu"
              aria-label="Folders"
              {...(reduceMotion
                ? FADE
                : {
                    initial: { opacity: 0, y: 6, scale: 0.96, filter: 'blur(4px)' },
                    animate: { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' },
                    exit: { opacity: 0, y: 4, scale: 0.98, filter: 'blur(2px)' },
                    transition: { duration: 0.2, ease: EASE },
                  })}
              style={{ position: 'fixed', left: pos.left, bottom: pos.bottom, zIndex: 50 }}
              className="bg-popover text-popover-foreground w-72 origin-bottom-left overflow-hidden rounded-2xl border-2 p-1.5 shadow-[0_8px_30px_-8px_rgba(0,0,0,0.45),0_2px_8px_-2px_rgba(0,0,0,0.3)]"
            >
              <div className="text-muted-foreground/70 px-2.5 pt-1.5 pb-1 text-[10px] font-semibold tracking-wide uppercase">Folders</div>
              <LayoutGroup id={groupId}>
                <motion.ul
                  role="presentation"
                  variants={list}
                  initial={reduceMotion ? false : 'hidden'}
                  animate="show"
                  onMouseLeave={() => setHovered(null)}
                  className="flex max-h-64 flex-col gap-0.5 overflow-y-auto"
                >
                  {projects.map((p) => {
                    const active = p.id === currentId;
                    return (
                      <motion.li
                        key={p.id}
                        role="none"
                        variants={reduceMotion ? itemReduced : item}
                        onMouseEnter={() => setHovered(p.id)}
                        className={cn(
                          'relative rounded-xl transition-colors duration-150 ease-[cubic-bezier(0.2,0,0,1)]',
                          active ? 'text-foreground' : 'text-muted-foreground',
                          hovered === p.id && !active && 'bg-muted/50',
                        )}
                      >
                        {active ? <motion.span layoutId={`${groupId}-active`} className="bg-muted absolute inset-0 rounded-xl" transition={SPRING_SOFT} /> : null}
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          onClick={() => choose(p.id)}
                          className="relative z-10 flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.98]"
                        >
                          <FolderIcon className="size-4 shrink-0 opacity-70" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{p.name}</span>
                            <span className="text-muted-foreground/60 block truncate font-mono text-[11px]">{p.path}</span>
                          </span>
                          <span className="flex size-3.5 shrink-0">
                            <AnimatePresence initial={false}>
                              {active ? (
                                <motion.span
                                  key="check"
                                  {...(reduceMotion
                                    ? FADE
                                    : {
                                        initial: { opacity: 0, scale: 0.9, filter: 'blur(4px)' },
                                        animate: { opacity: 1, scale: 1, filter: 'blur(0px)' },
                                        exit: { opacity: 0, scale: 0.9, filter: 'blur(4px)' },
                                        transition: { type: 'spring', duration: 0.3, bounce: 0 },
                                      })}
                                  className="flex"
                                >
                                  <CheckIcon className="size-3.5" aria-hidden />
                                </motion.span>
                              ) : null}
                            </AnimatePresence>
                          </span>
                        </button>
                      </motion.li>
                    );
                  })}
                </motion.ul>
              </LayoutGroup>
              <div role="separator" className="bg-border my-1.5 h-px" />
              <motion.button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onOpenFolder();
                }}
                initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: EASE, delay: reduceMotion ? 0 : 0.04 * projects.length }}
                className="text-muted-foreground hover:bg-muted/50 hover:text-foreground flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm font-medium transition-colors active:scale-[0.98]"
              >
                <FolderPlusIcon className="size-4 shrink-0 opacity-70" aria-hidden />
                Open folder…
              </motion.button>
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
