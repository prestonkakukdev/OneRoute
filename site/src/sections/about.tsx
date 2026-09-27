import { ArrowUpRightIcon } from 'lucide-react';
import { Reveal, SectionHeading } from '@/components/reveal';
import { GITHUB_URL, LICENSE_URL, NAV } from '@/content';
import { Wordmark } from './nav';

export function About() {
  return (
    <section id="about" className="mx-auto max-w-3xl px-6 pb-32">
      <SectionHeading eyebrow="About" title="Most requests don’t need the most expensive model." />
      <Reveal className="text-muted-foreground space-y-5 text-[16px] leading-relaxed">
        <p>
          The ones that do need it at the right effort. A greeting, a quick lookup and a hard proof are different jobs, yet most apps
          send all three to the same model at the same setting, and pay frontier prices for all of them.
        </p>
        <p>
          OneRoute treats routing as a decision to get right every time. Jev reads each request; a capability database built from
          independent benchmarks says what every model can do at every reasoning effort; plain, explainable code picks the best
          trade-off for the mode you choose. It learns from real answers, and it’s open source, so you can see exactly why it chose
          what it chose.
        </p>
        <p className="text-foreground/70 text-[14px]">
          Capability data from Artificial Analysis, LMArena and model providers’ own reports. Models served through OpenRouter.
          Requests read by TypeSafe’s Jev.
        </p>
      </Reveal>
    </section>
  );
}

export function License() {
  return (
    <section id="license" className="mx-auto max-w-5xl px-6 pb-32">
      <Reveal className="bg-card flex flex-wrap items-center justify-between gap-6 rounded-3xl border px-8 py-8">
        <div>
          <div className="text-arc mb-2 font-mono text-[11px] tracking-[0.2em] uppercase">License</div>
          <h2 className="font-display text-[26px] font-medium tracking-[-0.02em]">Apache 2.0. Use it, change it, ship it.</h2>
          <p className="text-muted-foreground mt-2 max-w-xl text-[14.5px]">
            Free for personal and commercial use, with an explicit patent grant. Keep the notice, and you’re set.
          </p>
        </div>
        <a
          href={LICENSE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground inline-flex items-center gap-1.5 rounded-full border px-5 py-2.5 text-[14px] transition-colors hover:bg-white/5"
        >
          Read the license
          <ArrowUpRightIcon className="size-4 opacity-60" aria-hidden />
        </a>
      </Reveal>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-6 px-6 py-10">
        <div className="flex items-center gap-4">
          <Wordmark className="text-[16px]" />
          <span className="text-muted-foreground/60 text-[13px]">© 2026 OneRoute contributors</span>
        </div>
        <div className="flex flex-wrap gap-6">
          {NAV.map((l) => (
            <a
              key={l.label}
              href={l.href}
              {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="text-muted-foreground hover:text-foreground text-[13.5px] transition-colors"
            >
              {l.label}
            </a>
          ))}
          <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground text-[13.5px] transition-colors">
            Issues
          </a>
        </div>
      </div>
    </footer>
  );
}
