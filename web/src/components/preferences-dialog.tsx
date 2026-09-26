import { AnimatePresence, motion } from 'framer-motion';
import * as React from 'react';
import type { Preferences } from '@/lib/api';
import { cn } from '@/lib/utils';

// Weights multiply how much each factor counts in the score; shown as plain words.
const WEIGHT_LEVELS: [number, string][] = [
  [0.25, "Doesn't matter much"],
  [0.5, 'Matters less'],
  [1, 'Normal'],
  [2, 'Matters more'],
  [4, 'Matters a lot'],
];
export const weightWord = (v: number) => WEIGHT_LEVELS.find(([w]) => w === v)?.[1] ?? `custom (×${v})`;

const FIELD = 'bg-background focus:border-foreground/25 h-9 w-full rounded-xl border px-2.5 text-[13px] outline-none';
const splitList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function WeightSelect({ id, value, onChange }: { id: string; value: number; onChange: (v: number) => void }) {
  const levels = WEIGHT_LEVELS.some(([w]) => w === value) ? WEIGHT_LEVELS : [...WEIGHT_LEVELS, [value, `Custom (×${value})`] as [number, string]].sort((a, b) => a[0] - b[0]);
  return (
    <select id={id} className={FIELD} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {levels.map(([w, t]) => (
        <option key={w} value={w}>
          {t}
        </option>
      ))}
    </select>
  );
}

export function PreferencesDialog({
  open,
  prefs,
  gatewayKey,
  onClose,
  onSave,
}: {
  open: boolean;
  prefs: Preferences;
  gatewayKey: string;
  onClose: () => void;
  onSave: (prefs: Preferences, gatewayKey: string) => void;
}) {
  const [draft, setDraft] = React.useState(prefs);
  const [prefer, setPrefer] = React.useState('');
  const [avoid, setAvoid] = React.useState('');
  const [key, setKey] = React.useState(gatewayKey);

  React.useEffect(() => {
    if (!open) return;
    setDraft(prefs);
    setPrefer((prefs.preferProviders ?? []).join(', '));
    setAvoid((prefs.avoidProviders ?? []).join(', '));
    setKey(gatewayKey);
  }, [open, prefs, gatewayKey]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const set = (patch: Partial<Preferences>) => setDraft((d) => ({ ...d, ...patch }));
  const row = (id: string, name: string, field: React.ReactNode, note?: string) => (
    <>
      <label htmlFor={id} className="text-muted-foreground">
        {name}
      </label>
      {field}
      {note ? <div className="text-muted-foreground/70 col-start-2 -mt-2 text-[11.5px]">{note}</div> : null}
    </>
  );

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
            aria-labelledby="prefs-title"
            initial={{ opacity: 0, y: 6, scale: 0.96, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: 4, scale: 0.98, filter: 'blur(2px)' }}
            transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
            className={cn(
              'bg-popover w-[min(480px,94vw)] rounded-[20px] border-2 p-5',
              'shadow-[0_8px_30px_-8px_rgba(0,0,0,0.45),0_2px_8px_-2px_rgba(0,0,0,0.3)]',
            )}
          >
            <h3 id="prefs-title" className="mb-1 text-base font-semibold">
              Preferences
            </h3>
            <p className="text-muted-foreground text-[13px]">These steer how the router trades quality, cost and speed.</p>
            <div className="mt-4 grid grid-cols-[140px_1fr] items-center gap-x-3.5 gap-y-3 text-[13px]">
              {row('pQuality', 'Answer quality', <WeightSelect id="pQuality" value={draft.qualityWeight ?? 1} onChange={(v) => set({ qualityWeight: v })} />, 'How much a better answer is worth to you')}
              {row('pCost', 'Saving money', <WeightSelect id="pCost" value={draft.costWeight ?? 1} onChange={(v) => set({ costWeight: v })} />, 'Matters less = stronger, pricier models are fine')}
              {row('pSpeed', 'Fast replies', <WeightSelect id="pSpeed" value={draft.speedWeight ?? 1} onChange={(v) => set({ speedWeight: v })} />, 'Matters more = prefer quicker models and lower effort')}
              {row(
                'pOpen',
                'Open weights',
                <select id="pOpen" className={FIELD} value={draft.openWeights ?? 'any'} onChange={(e) => set({ openWeights: e.target.value as Preferences['openWeights'] })}>
                  <option value="any">Any model</option>
                  <option value="prefer">Prefer open-weight</option>
                  <option value="only">Open-weight only</option>
                </select>,
              )}
              {row('pPrefer', 'Prefer providers', <input id="pPrefer" className={FIELD} placeholder="anthropic, google" value={prefer} onChange={(e) => setPrefer(e.target.value)} />)}
              {row('pAvoid', 'Avoid providers', <input id="pAvoid" className={FIELD} placeholder="x-ai" value={avoid} onChange={(e) => setAvoid(e.target.value)} />)}
              {row(
                'pMin',
                'Minimum quality',
                <input id="pMin" type="number" min={0} max={100} step={5} className={FIELD} value={draft.minQuality ?? 0} onChange={(e) => set({ minQuality: Number(e.target.value) || 0 })} />,
                '0-100 skill for the request',
              )}
              {row('pKey', 'Gateway key', <input id="pKey" className={FIELD} placeholder="only if ROUTER_API_KEY is set" value={key} onChange={(e) => setKey(e.target.value)} />)}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="text-muted-foreground hover:bg-muted hover:text-foreground h-9 cursor-pointer rounded-xl px-3.5 font-medium shadow-[inset_0_0_0_1px_var(--border)] transition-colors active:scale-[0.97]"
                onClick={() => onSave({}, key.trim())}
              >
                Reset
              </button>
              <button
                type="button"
                className="h-9 cursor-pointer rounded-xl bg-linear-to-b from-[#f7f7f7] to-white px-4 font-medium text-black transition-transform active:scale-[0.96]"
                onClick={() => onSave({ ...draft, preferProviders: splitList(prefer), avoidProviders: splitList(avoid) }, key.trim())}
              >
                Save
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
