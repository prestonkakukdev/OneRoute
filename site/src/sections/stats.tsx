import { Reveal } from '@/components/reveal';
import { STATS, STATS_FOOTNOTE } from '@/content';

// The headline numbers, OpenRouter-style: big figures in a quiet grid.
export function Stats() {
  return (
    <section aria-label="OneRoute in numbers" className="relative mx-auto max-w-6xl px-6 pb-28">
      <div className="grid grid-cols-4 overflow-hidden rounded-3xl border bg-white/[0.015] max-lg:grid-cols-2 max-sm:grid-cols-1">
        {STATS.map((s, i) => (
          <Reveal
            key={s.label}
            delay={i * 0.08}
            className="border-border flex flex-col gap-3 px-8 py-10 [&:not(:last-child)]:border-r max-lg:[&:nth-child(2)]:border-r-0 max-lg:[&:nth-child(-n+2)]:border-b max-sm:border-r-0 max-sm:[&:not(:last-child)]:border-b"
          >
            <div className="font-display text-[52px] leading-none font-medium tracking-[-0.04em] tabular-nums">
              {s.value}
              {s.estimate ? <span className="text-arc align-super text-[22px]">*</span> : null}
            </div>
            <div className="text-muted-foreground max-w-[15rem] text-[14px] leading-snug">{s.label}</div>
          </Reveal>
        ))}
      </div>
      <p className="text-muted-foreground/60 mt-4 text-center text-[12px]">
        <span className="text-arc">*</span> {STATS_FOOTNOTE}
      </p>
    </section>
  );
}
