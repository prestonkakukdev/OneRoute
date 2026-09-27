import { motion, useReducedMotion } from 'framer-motion';
import type * as React from 'react';

// Fade and un-blur into place once scrolled into view, like the app's entrances.
export function Reveal({ children, delay = 0, className }: { children: React.ReactNode; delay?: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, filter: 'blur(6px)' }}
      whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.6, delay, ease: [0.2, 0, 0, 1] }}
    >
      {children}
    </motion.div>
  );
}

export function SectionHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <Reveal className="mx-auto mb-12 max-w-2xl text-center">
      <div className="text-arc mb-3 font-mono text-[11px] tracking-[0.2em] uppercase">{eyebrow}</div>
      <h2 className="font-display text-[34px] leading-[1.12] font-medium tracking-[-0.02em] text-balance max-sm:text-[28px]">{title}</h2>
      {children ? <p className="text-muted-foreground mt-4 text-[15.5px] leading-relaxed text-balance">{children}</p> : null}
    </Reveal>
  );
}
