import { Reveal, SectionTitle } from '@/components/reveal';
import { ElitePlanCard } from '@/components/ui/elite-plan-card';
import { PLANS } from '@/content';

export function Pricing() {
  return (
    <section id="pricing" className="mx-auto max-w-5xl px-6 pb-32">
      <SectionTitle>Free to run yourself.</SectionTitle>
      <div className="flex flex-col gap-4">
        {PLANS.map((p, i) => (
          <Reveal key={p.title} delay={i * 0.1}>
            <ElitePlanCard
              orientation="horizontal"
              interactive={false}
              title={p.title}
              subtitle={p.subtitle}
              description={p.description}
              highlights={p.highlights}
              actionLabel={p.action}
              onAction={() => window.open(p.href, '_blank', 'noopener,noreferrer')}
              className="border border-white/8"
            />
          </Reveal>
        ))}
      </div>
    </section>
  );
}
