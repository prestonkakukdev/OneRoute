import { GlobeIcon, PaperclipIcon } from 'lucide-react';
import * as React from 'react';
import type { Decision, Mode } from '@/lib/api';
import { label, pct, secs, shortModel, usd } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Chip, PANEL_CLASS, SectionLabel } from './chip';
import { ErrorBox, type Turn } from './messages';

const MODE_LABEL: Record<Mode, string> = { cheap: 'Cheap', balanced: 'Balanced', best: 'Best' };

function Panel({ title, aside, children }: { title?: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={PANEL_CLASS}>
      {title ? (
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <SectionLabel>{title}</SectionLabel>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function Stat({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="bg-muted rounded-xl px-2.5 py-1.5 shadow-[inset_0_0_0_1px_rgba(123,123,123,0.12)]">
      <div className="text-muted-foreground/70 text-[10.5px] font-medium">{k}</div>
      <div className="text-sm font-semibold tabular-nums">{v}</div>
    </div>
  );
}

function Bars({ entries, max = 1, fmt = pct, limit = 99 }: { entries: [string, number][]; max?: number; fmt?: (v: number) => string; limit?: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      {entries.slice(0, limit).map(([k, v]) => (
        <div key={k} className="grid grid-cols-[150px_1fr_40px] items-center gap-2.5 text-[12.5px] max-lg:grid-cols-[110px_1fr_36px]">
          <span className="text-muted-foreground truncate" title={label(k)}>
            {label(k)}
          </span>
          <div className="bg-muted h-1.5 overflow-hidden rounded-full">
            <div className="bg-foreground h-full rounded-full transition-[width] duration-500 ease-[cubic-bezier(0.2,0,0,1)]" style={{ width: `${Math.max(0, Math.min(100, (v / max) * 100))}%` }} />
          </div>
          <span className="text-muted-foreground/70 text-right text-xs tabular-nums">{fmt(v)}</span>
        </div>
      ))}
    </div>
  );
}

function Levels({ title, dist, names }: { title: string; dist: { probabilities: Record<string, number> }; names: string[] }) {
  const top = Object.entries(dist.probabilities).sort((a, b) => b[1] - a[1])[0]?.[0];
  return (
    <div className="text-muted-foreground/70 grid items-end gap-1 text-[11px]" style={{ gridTemplateColumns: `88px repeat(${names.length}, 1fr)` }}>
      <span>{title}</span>
      {names.map((name, i) => {
        const p = dist.probabilities[i] ?? 0;
        const isTop = String(i) === top;
        return (
          <div key={name} className="flex flex-col items-center gap-0.5" title={`${name}: ${pct(p)}`}>
            <div className="bg-muted relative h-8 w-full overflow-hidden rounded-lg">
              <div className={cn('absolute inset-x-0 bottom-0 transition-[height] duration-500', isTop ? 'bg-foreground' : 'bg-foreground/35')} style={{ height: `${p * 100}%` }} />
            </div>
            <span className={cn(isTop && 'text-foreground')}>{name}</span>
          </div>
        );
      })}
    </div>
  );
}

function Signal({ name, p }: { name: string; p: number }) {
  return (
    <Chip tone={p >= 0.6 ? 'warn' : 'soft'}>
      {name} {pct(p)}
    </Chip>
  );
}

function attachmentBits(f: Decision['facts']): string[] {
  const a = f.attachments;
  if (!a) return f.hasImages ? ['images'] : [];
  const bits: string[] = [];
  if (a.images) bits.push(`${a.images} image${a.images > 1 ? 's' : ''}`);
  if (a.pdfs) bits.push(`${a.pdfs} PDF${a.pdfs > 1 ? 's' : ''}${a.pdfPages ? ` (${a.pdfPages} pages)` : ''}`);
  if (a.files) bits.push(`${a.files} file${a.files > 1 ? 's' : ''}`);
  return bits;
}

export function Inspector({ turn, onFeedback }: { turn?: Turn; onFeedback: (turn: Turn, success: boolean, note: string) => void }) {
  const [note, setNote] = React.useState('');
  React.useEffect(() => setNote(''), [turn?.id]);

  if (!turn) {
    return (
      <Panel title="Routing inspector">
        <p className="text-muted-foreground text-[13px]">
          Send a message, then click an answer to see Jev's reading, the capabilities the router looked for, and why the chosen model won.
        </p>
      </Panel>
    );
  }
  const d = turn.decision;
  if (!d) return <Panel>{turn.error ? <ErrorBox>{turn.error}</ErrorBox> : <span className="shimmer-text">Asking Jev and scoring models…</span>}</Panel>;

  const task = d.task;
  const win = d.candidates[0];
  const sorted = (o?: Record<string, number>) => Object.entries(o ?? {}).sort((a, b) => b[1] - a[1]);
  const top = d.candidates.slice(0, 8);
  const maxAbs = Math.max(
    ...top.map((c) => {
      const b = c.breakdown;
      return b ? b.value + b.quality + b.cost + b.latency + b.preference : 0;
    }),
    1e-9,
  );
  const rejected = Object.entries(d.rejected ?? {});
  const caps = sorted(task.capabilities).filter(([, v]) => v >= 0.05);
  const needs = sorted(d.needs);

  return (
    <>
      <Panel title="Chosen model" aside={<Chip tone="soft">{MODE_LABEL[d.mode] ?? d.mode}{turn.dryRun ? ' · route only' : ''}</Chip>}>
        <div className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">
          {d.modelId} <Chip>{d.effort} effort</Chip>
          {turn.done && turn.done.model !== d.modelId ? <Chip tone="warn">fell back to {shortModel(turn.done.model)}</Chip> : null}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs">
          <Chip tone={d.useWeb ? 'good' : 'soft'}>
            <GlobeIcon aria-hidden />
            Web search {d.useWeb ? 'on' : 'off'}
          </Chip>
          <span className="text-muted-foreground">{d.webReason}</span>
        </div>
        {win ? (
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            <Stat k="Est. success" v={pct(win.pSuccess)} />
            <Stat k="Est. cost" v={usd(win.estCostUsd)} />
            <Stat k="Est. time" v={secs(win.estLatencyS)} />
            {turn.done ? (
              <>
                <Stat k="Actual cost" v={usd(turn.done.usage?.cost)} />
                <Stat k="Actual time" v={secs(turn.done.latencyMs / 1000)} />
                <Stat k="Tokens in / out" v={`${turn.done.usage?.prompt_tokens ?? '–'} / ${turn.done.usage?.completion_tokens ?? '–'}`} />
              </>
            ) : null}
          </div>
        ) : null}
      </Panel>

      <Panel title="Why this model">
        <ul className="flex flex-col gap-2 text-[13px] leading-relaxed">
          {turn.why.map((w, i) => (
            <li key={i} className="grid grid-cols-[14px_1fr] gap-2">
              <span className="bg-muted-foreground/70 mt-[7px] ml-1 size-1.5 rounded-full" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel
        title="Jev's reading"
        aside={
          <span className="text-muted-foreground font-mono text-[11.5px]">
            {task.source === 'jev' ? `${Math.round(task.latencyMs)} ms` : 'keyword fallback'} · routed {Math.round(d.routeMs)} ms
          </span>
        }
      >
        {task.error ? <ErrorBox>Jev error: {task.error}</ErrorBox> : null}
        <SectionLabel className="mb-2">Task type · {pct(task.taskType.confidence)} confident</SectionLabel>
        <Bars entries={sorted(task.taskType.probabilities).filter(([, v]) => v >= 0.01)} limit={4} />
        <div className="mt-3.5 grid gap-2">
          <Levels title="Difficulty" dist={task.difficulty} names={['trivial', 'easy', 'moderate', 'hard', 'frontier']} />
          <Levels title="Reasoning" dist={task.reasoningDepth} names={['none', 'a little', 'careful', 'extensive']} />
          <Levels title="Answer length" dist={task.outputLength} names={['short', 'paragraphs', 'document', 'very long']} />
        </div>
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          <Signal name="wants speed" p={task.latencySensitive} />
          <Signal name="high stakes" p={task.highStakes} />
          <Signal name="needs web" p={task.needsWeb} />
          <Signal name="too vague" p={task.underspecified ?? 0} />
        </div>
        <SectionLabel className="mt-4 mb-2">Capability importance</SectionLabel>
        {caps.length ? <Bars entries={caps} /> : <div className="text-muted-foreground text-[12.5px]">No extra capabilities rated important.</div>}
      </Panel>

      <Panel title="What the router looked for">
        <p className="text-muted-foreground mb-2.5 text-xs">
          Capability weights used to score models (task mix + Jev + request facts). The weakest weighted capability counts most.
        </p>
        <Bars entries={needs} max={Math.max(...needs.map(([, v]) => v), 1e-9)} fmt={(v) => v.toFixed(2)} />
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Chip tone="soft">~{d.facts.inputTokens.toLocaleString()} input tokens</Chip>
          {attachmentBits(d.facts).map((b) => (
            <Chip key={b} tone="soft">
              <PaperclipIcon aria-hidden />
              {b}
            </Chip>
          ))}
          {d.facts.toolsPresent ? <Chip tone="soft">tools</Chip> : null}
          {d.stickyModel ? <Chip>sticky: {shortModel(d.stickyModel)}</Chip> : null}
        </div>
      </Panel>

      <Panel title="Top candidates" aside={<span className="text-muted-foreground text-[11px]">value + quality − cost − time − preference</span>}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="text-muted-foreground/70 border-b text-[10px] font-semibold tracking-wide uppercase">
                <th className="p-1.5 text-left">Model</th>
                <th className="p-1.5 text-left">Effort</th>
                <th className="p-1.5 text-right">P</th>
                <th className="p-1.5 text-right">Cost</th>
                <th className="p-1.5 text-right">Time</th>
                <th className="p-1.5 text-left">Breakdown</th>
                <th className="p-1.5 text-right">Score</th>
              </tr>
            </thead>
            <tbody>
              {top.map((c, i) => {
                const b = c.breakdown ?? { value: 0, quality: 0, cost: 0, latency: 0, preference: 0 };
                const pos = ((b.value + b.quality) / maxAbs) * 100;
                const neg = ((b.cost + b.latency + b.preference) / maxAbs) * 100;
                return (
                  <tr
                    key={`${c.modelId}-${c.effort}`}
                    className={cn('text-muted-foreground border-b border-white/5 whitespace-nowrap', i === 0 && 'text-foreground [&>td]:bg-muted first:[&>td]:rounded-l-[10px] last:[&>td]:rounded-r-[10px]')}
                    title={`value ${usd(b.value)} · quality ${usd(b.quality)} · cost −${usd(b.cost)} · time −${usd(b.latency)} · preference −${usd(b.preference)}`}
                  >
                    <td className="p-1.5">{shortModel(c.modelId)}</td>
                    <td className="p-1.5">{c.effort}</td>
                    <td className="p-1.5 text-right tabular-nums">{pct(c.pSuccess)}</td>
                    <td className="p-1.5 text-right tabular-nums">{usd(c.estCostUsd)}</td>
                    <td className="p-1.5 text-right tabular-nums">{secs(c.estLatencyS)}</td>
                    <td className="p-1.5">
                      <div className="bg-muted flex h-1.5 w-21 overflow-hidden rounded-full">
                        <div className="bg-good/85" style={{ width: `${pos}%` }} />
                        <div className="bg-bad/85" style={{ width: `${neg}%` }} />
                      </div>
                    </td>
                    <td className="p-1.5 text-right font-mono tabular-nums">{c.utility.toFixed(4)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground mt-2 text-[11.5px]">Green = value of a good answer · red = cost, waiting time and preference penalties. Hover a row for numbers.</p>
        {rejected.length ? (
          <details className="mt-2.5 text-[12.5px]">
            <summary className="text-muted-foreground cursor-pointer">{rejected.length} models ruled out</summary>
            <div className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {rejected.map(([m, r]) => (
                <div key={m}>
                  {shortModel(m)}: {r}
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </Panel>

      {turn.done ? (
        <Panel title="Was this a good answer?" aside={<span className="text-muted-foreground text-xs">{turn.feedback}</span>}>
          <div className="flex flex-wrap items-center gap-1.5">
            <FeedbackButton onClick={() => onFeedback(turn, true, note)}>👍 Good</FeedbackButton>
            <FeedbackButton onClick={() => onFeedback(turn, false, note)}>👎 Bad</FeedbackButton>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note: what went wrong?"
              className="bg-background focus:border-foreground/25 h-9 min-w-40 flex-1 rounded-xl border px-3 text-[13px] outline-none"
            />
          </div>
        </Panel>
      ) : null}

      <Panel>
        <details>
          <summary className="text-muted-foreground cursor-pointer text-[12.5px]">Raw decision JSON</summary>
          <pre className="bg-background mt-2.5 max-h-85 overflow-auto rounded-xl border p-2.5 font-mono text-[11.5px]">{JSON.stringify(d, null, 2)}</pre>
        </details>
      </Panel>
    </>
  );
}

function FeedbackButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground hover:bg-muted hover:text-foreground h-9 cursor-pointer rounded-xl px-3 text-[13px] font-medium shadow-[inset_0_0_0_1px_var(--border)] transition-colors active:scale-[0.97]"
    >
      {children}
    </button>
  );
}
