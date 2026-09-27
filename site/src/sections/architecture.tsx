import { CheckIcon, MinusIcon } from 'lucide-react';
import { Reveal, SectionTitle } from '@/components/reveal';
import { COMPARISON, STEPS } from '@/content';
import { cn } from '@/lib/utils';
import { BAND_CELL, Band } from './stats';

export function Architecture() {
  return (
    <section id="architecture" className="mx-auto max-w-6xl px-6 pb-32">
      <SectionTitle>A classifier reads. Plain code decides.</SectionTitle>
      {/* Same width as the comparison table below, in a rounded frame */}
      <Band className="overflow-hidden rounded-3xl border">
        {STEPS.map((s, i) => (
          <Reveal key={s.n} delay={i * 0.08} className={cn(BAND_CELL, 'gap-3 px-8 py-10 max-xl:px-7')}>
            <div className="text-arc font-mono text-[12px]">{s.n}</div>
            <h3 className="font-display text-[26px] leading-none font-medium tracking-[-0.02em]">{s.title}</h3>
            <p className="text-muted-foreground max-w-[17rem] text-[14.5px] leading-snug">{s.body}</p>
          </Reveal>
        ))}
      </Band>
    </section>
  );
}

function Cell({ value, highlight }: { value: boolean | string | null; highlight?: boolean }) {
  if (value === true)
    return (
      <span className={cn('inline-flex size-6 items-center justify-center rounded-full', highlight ? 'bg-arc/15 text-arc' : 'bg-white/5 text-foreground/80')}>
        <CheckIcon className="size-3.5" aria-label="Yes" />
      </span>
    );
  if (value === false) return <MinusIcon className="text-muted-foreground/40 inline size-4" aria-label="No" />;
  if (value === null) return <span className="text-muted-foreground/40 text-[13px]">n/a</span>;
  return <span className="text-muted-foreground text-[13px]">{value}</span>;
}

export function Comparison() {
  return (
    <section id="why" className="mx-auto max-w-6xl px-6 pb-32">
      <SectionTitle>How OneRoute compares</SectionTitle>
      <Reveal>
        <div className="overflow-x-auto rounded-2xl border">
          <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-b">
                <th className="px-6 py-4 font-normal" />
                {COMPARISON.columns.map((c, i) => (
                  <th key={c} className={cn('px-4 py-4 text-center text-[13px] font-medium', i === 0 ? 'text-foreground' : 'text-muted-foreground')}>
                    {i === 0 ? <span className="font-wordmark text-[15px] font-medium tracking-[-0.02em]">{c}</span> : c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON.rows.map((r) => (
                <tr key={r.label} className="border-b last:border-b-0">
                  <td className="text-foreground/85 px-6 py-4">{r.label}</td>
                  {r.values.map((v, i) => (
                    <td key={i} className={cn('px-4 py-4 text-center', i === 0 && 'bg-white/[0.02]')}>
                      <Cell value={v} highlight={i === 0} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>
    </section>
  );
}
