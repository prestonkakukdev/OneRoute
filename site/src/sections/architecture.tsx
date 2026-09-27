import { CheckIcon, MinusIcon } from 'lucide-react';
import { Reveal, SectionHeading } from '@/components/reveal';
import { COMPARISON, STEPS } from '@/content';
import { cn } from '@/lib/utils';

export function Architecture() {
  return (
    <section id="architecture" className="mx-auto max-w-6xl px-6 pb-32">
      <SectionHeading eyebrow="The architecture" title="A classifier reads the request. Plain code makes the call.">
        No model guessing which model to use. OneRoute separates understanding a request from deciding where it goes, so every
        choice is fast, repeatable and explained.
      </SectionHeading>

      <div className="grid grid-cols-4 gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
        {STEPS.map((s, i) => (
          <Reveal key={s.n} delay={i * 0.08} className="group bg-card relative rounded-2xl border p-6 transition-colors duration-300 hover:border-white/15">
            <div className="text-arc font-mono text-[12px]">{s.n}</div>
            <h3 className="font-display mt-3 text-[20px] font-medium tracking-[-0.01em]">{s.title}</h3>
            <p className="text-muted-foreground mt-2 text-[14px] leading-relaxed">{s.body}</p>
          </Reveal>
        ))}
      </div>

      <Reveal delay={0.1} className="mt-4">
        <div className="bg-card flex flex-wrap items-center justify-between gap-4 rounded-2xl border px-6 py-5">
          <span className="text-muted-foreground text-[14px]">For every model at every reasoning effort:</span>
          <code className="font-mono text-[15px] tracking-tight max-sm:text-[13px]">
            score = <span className="text-arc">P(success)</span> × value − cost − wait
          </code>
        </div>
      </Reveal>
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
    <section id="why" className="mx-auto max-w-5xl px-6 pb-32">
      <SectionHeading eyebrow="Why it wins" title="Built to decide, not to guess.">
        {COMPARISON.note}
      </SectionHeading>
      <Reveal>
        <div className="overflow-x-auto rounded-2xl border">
          <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-b">
                <th className="px-6 py-4 font-normal" />
                {COMPARISON.columns.map((c, i) => (
                  <th key={c} className={cn('px-4 py-4 text-center text-[13px] font-medium', i === 0 ? 'text-foreground' : 'text-muted-foreground')}>
                    {i === 0 ? <span className="font-wordmark text-[15px] font-[379]">{c}</span> : c}
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
