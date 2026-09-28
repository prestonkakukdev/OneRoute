import { BrainIcon, CheckIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { type CodeMemory, codeApi } from './api';

const ICON_BTN =
  'text-muted-foreground/70 hover:bg-accent hover:text-foreground flex size-6.5 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors duration-150 [&_svg]:size-3.5';

function MemoryRow({ m, onSave, onDelete }: { m: CodeMemory; onSave: (text: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(m.text);
  const commit = () => {
    const next = text.trim();
    if (next && next !== m.text) onSave(next);
    else setText(m.text);
    setEditing(false);
  };
  return (
    <li className="group/mem flex items-start gap-2 rounded-lg border px-2.5 py-2">
      {editing ? (
        <textarea
          autoFocus
          value={text}
          rows={2}
          aria-label="Memory"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') {
              setText(m.text);
              setEditing(false);
            }
          }}
          className="bg-background min-w-0 flex-1 resize-none rounded-md border px-2 py-1 text-[12.5px] outline-none"
        />
      ) : (
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] leading-relaxed">{m.text}</p>
          <p className="text-muted-foreground/60 mt-0.5 text-[10.5px]">{m.source === 'learned' ? 'learned from a session' : 'added by you'}</p>
        </div>
      )}
      <div className={cn('flex items-center opacity-0 transition-opacity group-hover/mem:opacity-100 focus-within:opacity-100', editing && 'opacity-100')}>
        {editing ? (
          <button type="button" aria-label="Save" onMouseDown={(e) => e.preventDefault()} onClick={commit} className={ICON_BTN}>
            <CheckIcon aria-hidden />
          </button>
        ) : (
          <button type="button" aria-label="Edit" onClick={() => setEditing(true)} className={ICON_BTN}>
            <PencilIcon aria-hidden />
          </button>
        )}
        <button type="button" aria-label="Forget" onClick={onDelete} className={ICON_BTN}>
          <Trash2Icon aria-hidden />
        </button>
      </div>
    </li>
  );
}

// What OneRoute Code knows about a project: learned after sessions, or written here. Every run reads it.
export function MemoryPanel({ projectId, projectName, refreshKey }: { projectId: string; projectName: string; refreshKey: number }) {
  const [items, setItems] = React.useState<CodeMemory[]>([]);
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [error, setError] = React.useState('');

  const load = React.useCallback(async () => {
    try {
      setItems(await codeApi.memory(projectId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [projectId]);
  React.useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const add = () => {
    const text = draft.trim();
    if (!text) return setAdding(false);
    void act(() => codeApi.addMemory(projectId, text)).then(() => {
      setDraft('');
      setAdding(false);
    });
  };

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <div className="flex items-start gap-2 px-1">
        <BrainIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
        <p className="text-muted-foreground text-[12.5px] leading-relaxed">
          What the agent knows about <span className="text-foreground">{projectName}</span>. It learns from your corrections and from what fails, and reads this at the start of every run. Edit or remove anything that’s wrong.
        </p>
      </div>
      {error ? <p className="text-bad px-1 text-xs">{error}</p> : null}
      <ul className="flex flex-col gap-1.5">
        {items.map((m) => (
          <MemoryRow key={m.id} m={m} onSave={(text) => void act(() => codeApi.editMemory(projectId, m.id, text))} onDelete={() => void act(() => codeApi.deleteMemory(projectId, m.id))} />
        ))}
      </ul>
      {!items.length && !adding ? <p className="text-muted-foreground/70 px-1 text-[12.5px]">Nothing yet. Things like “we use pnpm” or “don’t edit files in dist/” end up here.</p> : null}
      {adding ? (
        <div className="flex items-start gap-1.5">
          <textarea
            autoFocus
            rows={2}
            value={draft}
            placeholder="e.g. Run tests with pnpm test; never edit generated files in src/gen/"
            aria-label="New memory"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                add();
              }
              if (e.key === 'Escape') setAdding(false);
            }}
            className="bg-background min-w-0 flex-1 resize-none rounded-lg border px-2.5 py-1.5 text-[12.5px] outline-none"
          />
          <button type="button" aria-label="Add" onClick={add} className={ICON_BTN}>
            <CheckIcon aria-hidden />
          </button>
          <button type="button" aria-label="Cancel" onClick={() => setAdding(false)} className={ICON_BTN}>
            <XIcon aria-hidden />
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 self-start px-1 text-[12.5px] transition-colors">
          <PlusIcon className="size-3.5" aria-hidden />
          Add a note for the agent
        </button>
      )}
    </div>
  );
}
