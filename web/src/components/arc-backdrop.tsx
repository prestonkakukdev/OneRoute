import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

// A large glowing blue arc (a planet's horizon seen from space), drawn in SVG so it stays sharp at any
// size: a wide soft halo, a saturated blue band, and a bright lavender rim, each blurred, over a dark
// interior that fades into the page.
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
        animate={reduceMotion ? undefined : { opacity: [0.88, 1, 0.88] }}
        transition={{ duration: 7, ease: 'easeInOut', repeat: Infinity }}
      >
        <defs>
          <filter id="arc-halo" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="55" />
          </filter>
          <filter id="arc-band" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="18" />
          </filter>
          <filter id="arc-rim" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
          {/* The planet's dark side: fades from the page colour at the rim to deeper black inside */}
          <radialGradient id="arc-core" cx="800" cy="1150" r="900" gradientUnits="userSpaceOnUse">
            <stop offset="0.72" stopColor="#030309" />
            <stop offset="0.96" stopColor="#0a0a1c" />
            <stop offset="1" stopColor="#0a0a0a" stopOpacity="0" />
          </radialGradient>
          {/* Fade the arc's lower ends into the page so it sits behind the chat, not across it */}
          <linearGradient id="arc-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.45" stopColor="white" />
            <stop offset="0.95" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <mask id="arc-mask">
            <rect width="1600" height="1000" fill="url(#arc-fade)" />
          </mask>
        </defs>
        <g mask="url(#arc-mask)">
          <circle cx="800" cy="1150" r="900" fill="none" stroke="#3b2cff" strokeOpacity="0.55" strokeWidth="190" filter="url(#arc-halo)" />
          <circle cx="800" cy="1150" r="880" fill="none" stroke="#5647ff" strokeOpacity="0.85" strokeWidth="70" filter="url(#arc-band)" />
          <circle cx="800" cy="1150" r="900" fill="none" stroke="#a9a2ff" strokeOpacity="0.9" strokeWidth="26" filter="url(#arc-rim)" />
          <circle cx="800" cy="1150" r="888" fill="url(#arc-core)" />
          <circle cx="800" cy="1150" r="866" fill="none" stroke="#6b5cff" strokeOpacity="0.35" strokeWidth="60" filter="url(#arc-band)" />
        </g>
      </motion.svg>
    </motion.div>
  );
}
