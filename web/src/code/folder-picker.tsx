import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeftIcon, FolderGitIcon, FolderIcon, HomeIcon } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { codeApi, type FolderListing } from './api';

// Pick a project folder on this computer (the local server lists folders; the browser can't see paths).
export function FolderPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (path: string) => Promise<void> }) {
  const [listing, setListing] = React.useState<FolderListing>();
  const [typed, setTyped] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const go = React.useCallback(async (path?: string) => {
    setError('');
    try {
      const l = await codeApi.browse(path);
      setListing(l);
      setTyped(l.path);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  React.useEffect(() => {
    if (open) void go();
  }, [open, go]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const pick = async (path: string) => {
    setBusy(true);
    setError('');
    try {
      await onPick(path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const crumbs = listing
    ? listing.path
        .replace(listing.home, '~')
        .split('/')
        .filter(Boolean)
        .map((part, i, all) => ({ part, path: all.slice(0, i + 1).join('/').replace(/^~/, listing.home) || '/' }))
    : [];

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4 backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Open a project folder"
            initial={{ opacity: 0, y: 6, scale: 0.96, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: 4, scale: 0.98, filter: 'blur(2px)' }}
            transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
            className="bg-popover flex max-h-[80vh] w-[min(560px,94vw)] flex-col overflow-hidden rounded-[20px] border-2 shadow-[0_8px_30px_-8px_rgba(0,0,0,0.45),0_2px_8px_-2px_rgba(0,0,0,0.3)]"
          >
            <div className="border-b p-4">
              <h3 className="text-base font-semibold">Open a folder</h3>
              <p className="text-muted-foreground mt-0.5 text-[13px]">OneRoute works directly in the folder you pick, and only there.</p>
              <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-1 text-[12.5px]">
                <button type="button" aria-label="Home folder" onClick={() => void go()} className="hover:text-foreground flex cursor-pointer items-center rounded-md p-1">
                  <HomeIcon className="size-3.5" />
                </button>
                {crumbs.map((c, i) => (
                  <React.Fragment key={c.path}>
                    <span className="opacity-40">/</span>
                    <button type="button" onClick={() => void go(c.path)} className={cn('hover:text-foreground cursor-pointer rounded-md px-1', i === crumbs.length - 1 && 'text-foreground')}>
                      {c.part}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {listing?.parent ? (
                <button type="button" onClick={() => void go(listing.parent!)} className="text-muted-foreground hover:bg-muted/60 hover:text-foreground flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px]">
                  <ChevronLeftIcon className="size-4" />
                  Up
                </button>
              ) : null}
              {listing?.entries.map((e) => (
                <button
                  key={e.path}
                  type="button"
                  onClick={() => void go(e.path)}
                  onDoubleClick={() => void pick(e.path)}
                  className="hover:bg-muted/60 flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px]"
                >
                  {e.git ? <FolderGitIcon className="text-arc size-4 shrink-0" /> : <FolderIcon className="text-muted-foreground size-4 shrink-0" />}
                  <span className="truncate">{e.name}</span>
                  {e.git ? <span className="text-muted-foreground/60 ml-auto text-[11px]">git</span> : null}
                </button>
              ))}
              {listing && !listing.entries.length ? <p className="text-muted-foreground px-3 py-2 text-[13px]">No subfolders.</p> : null}
            </div>
            <form
              className="flex flex-col gap-2 border-t p-4"
              onSubmit={(e) => {
                e.preventDefault();
                void pick(typed.trim());
              }}
            >
              {error ? (
                <p role="alert" className="text-bad text-[12.5px]">
                  {error}
                </p>
              ) : null}
              <div className="flex gap-2">
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  aria-label="Folder path"
                  className="bg-background focus:border-foreground/25 h-9 min-w-0 flex-1 rounded-xl border px-3 font-mono text-[12.5px] outline-none"
                />
                <button
                  type="submit"
                  disabled={busy || !typed.trim()}
                  className="h-9 cursor-pointer rounded-xl bg-linear-to-b from-[#f7f7f7] to-white px-4 text-[13px] font-medium text-black disabled:opacity-50 active:scale-[0.97]"
                >
                  Open this folder
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
