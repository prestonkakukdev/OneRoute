import { SectionHeading, Reveal } from '@/components/reveal';
import { ElitePlanCard } from '@/components/ui/elite-plan-card';
import { PLANS } from '@/content';

export function Pricing() {
  return (
    <section id="pricing" className="mx-auto max-w-5xl px-6 pb-32">
      <SectionHeading eyebrow="Pricing" title="Free to run yourself. Hosted when you’d rather not.">
        Self-hosted OneRoute has no fee: you pay model providers directly, at their prices.
      </SectionHeading>
      <div className="flex flex-wrap justify-center gap-6">
        {PLANS.map((p, i) => (
          <Reveal key={p.title} delay={i * 0.1} className="w-full max-w-sm">
            <ElitePlanCard
              imageUrl="/arc-card.webp"
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
