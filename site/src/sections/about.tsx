import { Reveal } from '@/components/reveal';
import { GITHUB_URL, LICENSE_URL, NAV } from '@/content';
import { Wordmark } from './nav';

const SOURCES = ['Artificial Analysis', 'LMArena', 'OpenRouter', 'TypeSafe Jev'];

export function About() {
  return (
    <section id="about" className="mx-auto max-w-4xl px-6 pb-36 text-center">
      <Reveal>
        <p className="font-display text-[44px] leading-[1.1] font-medium tracking-[-0.03em] text-balance max-md:text-[34px] max-sm:text-[27px]">
          Most requests don’t need the most expensive model.{' '}
          <span className="bg-linear-to-r from-[#c3bfff] via-[#a39ef4] to-[#6f5cff] bg-clip-text text-transparent">
            The ones that do need it at the right effort.
          </span>
        </p>
      </Reveal>
      <Reveal delay={0.1}>
        <p className="text-muted-foreground mx-auto mt-8 max-w-2xl text-[16px] leading-relaxed text-balance">
          OneRoute treats every request as a decision to get right: what it needs, which model can do it, at what effort, for what
          price. Open source, so you can see exactly why it chose what it chose.
        </p>
      </Reveal>
      <Reveal delay={0.2} className="mt-12 flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
        <span className="text-muted-foreground/50 text-[12px] tracking-[0.12em] uppercase">Built on</span>
        {SOURCES.map((s, i) => (
          <span key={s} className="text-muted-foreground flex items-center gap-3 text-[14px]">
            {i > 0 ? <span className="bg-muted-foreground/30 size-1 rounded-full" aria-hidden /> : null}
            {s}
          </span>
        ))}
      </Reveal>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-6 px-6 py-10">
        <div className="flex items-center gap-4">
          <Wordmark className="text-[17px]" />
          <span className="text-muted-foreground/60 text-[13px]">
            © 2026 OneRoute contributors ·{' '}
            <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">
              Apache 2.0
            </a>
          </span>
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
