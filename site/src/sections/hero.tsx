import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRightIcon } from 'lucide-react';
import { ArcBackdrop } from '../../../web/src/components/arc-backdrop';
import { Button } from '@/components/ui/button';
import { GITHUB_URL, QUICK_START_URL } from '@/content';

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

export function Hero() {
  const reduce = useReducedMotion();
  const rise = (delay: number) => ({
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 12, filter: 'blur(8px)' },
    animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
    transition: { duration: 0.8, delay, ease: [0.2, 0, 0, 1] as const },
  });
  return (
    <section id="top" className="relative isolate flex min-h-[100svh] flex-col overflow-hidden">
      <ArcBackdrop className="-z-10" />
      {/* Soft fade into the page below the arc */}
      <div aria-hidden className="from-background pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-40 bg-linear-to-t to-transparent" />
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 pt-[27vh] pb-20 text-center max-md:pt-[33vh]">
        <motion.h1
          {...rise(0.15)}
          className="font-wordmark text-[128px] leading-[0.9] font-medium tracking-[-0.055em] max-lg:text-[104px] max-md:text-[84px] max-sm:text-[64px]"
        >
          OneRoute
        </motion.h1>
        <motion.p
          {...rise(0.25)}
          className="font-display text-foreground/90 mt-6 text-[26px] leading-snug font-normal tracking-[-0.02em] text-balance max-sm:text-[21px]"
        >
          The routing architecture defined by speed and efficiency.
        </motion.p>
        <motion.p {...rise(0.35)} className="text-muted-foreground mt-4 max-w-xl text-[17px] leading-relaxed text-balance max-sm:text-[15.5px]">
          One API for 100+ models. OneRoute reads every request and sends it to the model and reasoning effort that fits: frontier answers
          when they matter, fast and cheap ones when they don’t.
        </motion.p>
        <motion.div {...rise(0.45)} className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg" className="group rounded-full px-6 text-[14.5px]">
            <a href={QUICK_START_URL} target="_blank" rel="noopener noreferrer">
              Get started
              <ArrowRightIcon className="ml-1.5 size-4 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />
            </a>
          </Button>
          <Button asChild size="lg" variant="outline" className="rounded-full border-white/12 bg-white/[0.03] px-6 text-[14.5px] backdrop-blur hover:bg-white/[0.07]">
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
              <GithubMark className="mr-2 size-4" />
              View on GitHub
            </a>
          </Button>
        </motion.div>
      </div>
    </section>
  );
}
