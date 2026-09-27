import { Reveal } from '@/components/reveal';
import { STATS, STATS_FOOTNOTE } from '@/content';
import { cn } from '@/lib/utils';

// A full-width band of numbers, divided by hairlines. Also used for the architecture steps.
export function Band({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-4 border-y max-lg:grid-cols-2 max-sm:grid-cols-1', className)}>{children}</div>
  );
}

export const BAND_CELL =
  'flex flex-col px-10 py-12 max-xl:px-8 [&:not(:last-child)]:border-r max-lg:[&:nth-child(2)]:border-r-0 max-lg:[&:nth-child(-n+2)]:border-b max-sm:border-r-0 max-sm:[&:not(:last-child)]:border-b';

export function Stats() {
  return (
    <section aria-label="OneRoute in numbers" className="pb-32">
      <Band>
        {STATS.map((s, i) => (
          <Reveal key={s.label} delay={i * 0.08} className={cn(BAND_CELL, 'gap-4')}>
            <div className="font-display text-[64px] leading-none font-medium tracking-[-0.045em] tabular-nums max-xl:text-[56px]">
              {s.value}
              {s.estimate ? <span className="text-arc align-super text-[24px]">*</span> : null}
            </div>
            <div className="text-muted-foreground max-w-[17rem] text-[14.5px] leading-snug">{s.label}</div>
          </Reveal>
        ))}
      </Band>
      <p className="text-muted-foreground/60 mt-4 text-center text-[12px]">
        <span className="text-arc">*</span> {STATS_FOOTNOTE}
      </p>
    </section>
  );
}
