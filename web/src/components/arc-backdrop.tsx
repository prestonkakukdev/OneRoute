import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

// A large glowing blue arc (a planet's horizon seen from space), drawn in SVG so it stays sharp at any
// size: blurred rings for the lavender band, its blue inner edge and the glows on either side.
export function ArcBackdrop({ className }: { className?: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      aria-hidden
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
      initial={{ opacity: 0, scale: 1.04, filter: 'blur(8px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, filter: 'blur(8px)' }}
      transition={{ duration: 0.9, ease: [0.2, 0, 0, 1] }}
    >
      <motion.svg
        viewBox="0 0 1600 1000"
        preserveAspectRatio="xMidYMin slice"
        className="absolute inset-x-0 top-0 h-full w-full"
        animate={reduceMotion ? undefined : { opacity: [0.9, 1, 0.9] }}
        transition={{ duration: 7, ease: 'easeInOut', repeat: Infinity }}
      >
        <defs>
          <filter id="arc-soft" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="12" />
          </filter>
          <filter id="arc-edge" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="10" />
          </filter>
          <filter id="arc-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="40" />
          </filter>
          {/* Fade the arc's lower ends into the page so it sits behind the chat, not across it */}
          <linearGradient id="arc-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.5" stopColor="white" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <mask id="arc-mask">
            <rect width="1600" height="1000" fill="url(#arc-fade)" />
          </mask>
        </defs>
        {/* Outside to inside: faint violet haze, the wide lavender band (with a lighter outer rim), a
            saturated blue inner edge, and a blue glow falling off into the dark side. */}
        <g mask="url(#arc-mask)">
          <circle cx="800" cy="1130" r="935" fill="none" stroke="#2e2596" strokeOpacity="0.35" strokeWidth="70" filter="url(#arc-glow)" />
          <circle cx="800" cy="1130" r="805" fill="none" stroke="#3322d6" strokeOpacity="0.5" strokeWidth="80" filter="url(#arc-glow)" />
          <circle cx="800" cy="1130" r="876" fill="none" stroke="#a39ef4" strokeOpacity="0.97" strokeWidth="90" filter="url(#arc-soft)" />
          <circle cx="800" cy="1130" r="898" fill="none" stroke="#bcb8ff" strokeOpacity="0.4" strokeWidth="30" filter="url(#arc-soft)" />
          <circle cx="800" cy="1130" r="830" fill="none" stroke="#5a44ff" strokeOpacity="0.95" strokeWidth="30" filter="url(#arc-edge)" />
        </g>
      </motion.svg>
    </motion.div>
  );
}
