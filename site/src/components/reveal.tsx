import { motion, useReducedMotion } from 'framer-motion';
import type * as React from 'react';
import { cn } from '@/lib/utils';

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

export function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Reveal className={cn('mx-auto mb-14 max-w-3xl text-center', className)}>
      <h2 className="font-display text-[40px] leading-[1.08] font-medium tracking-[-0.03em] text-balance max-sm:text-[30px]">{children}</h2>
    </Reveal>
  );
}
