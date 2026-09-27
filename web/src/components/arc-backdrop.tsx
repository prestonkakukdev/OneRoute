import { motion, useReducedMotion } from 'framer-motion';
import { arcBand, arcLine, bandEdge } from '../lib/arc';
import { cn } from '../lib/utils';

// A large glowing blue arc (a planet's horizon seen from space), drawn in SVG so it stays sharp at any
// size. The shape comes from lib/arc (a parabola with a tapered band); the layers are blurred.
const ARC = {
  haze: arcLine(-30, bandEdge('outer')),
  inner: arcLine(30, bandEdge('inner')),
  band: arcBand(),
  rim: arcLine(14, bandEdge('outer')),
  edge: arcLine(0, bandEdge('inner')),
};

// Horizontal falloff for a stroke: full strength in the middle, `edge` opacity at the sides.
function Falloff({ id, color, edge }: { id: string; color: string; edge: number }) {
  return (
    <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1600" y2="0">
      <stop offset="0" stopColor={color} stopOpacity={edge} />
      <stop offset="0.5" stopColor={color} stopOpacity={1} />
      <stop offset="1" stopColor={color} stopOpacity={edge} />
    </linearGradient>
  );
}
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
        viewBox="250 40 1100 766"
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
            <feGaussianBlur stdDeviation="9" />
          </filter>
          <filter id="arc-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="40" />
          </filter>
          {/* Lighting peaks in the middle of the arc and falls off toward its ends */}
          <Falloff id="arc-g-haze" color="#2e2596" edge={0.4} />
          <Falloff id="arc-g-inner" color="#3322d6" edge={0.5} />
          <Falloff id="arc-g-rim" color="#c3bfff" edge={0.25} />
          <Falloff id="arc-g-edge" color="#5a44ff" edge={0.55} />
          <linearGradient id="arc-g-band" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1600" y2="0">
            <stop offset="0" stopColor="#6c62e4" stopOpacity="0.6" />
            <stop offset="0.3" stopColor="#928cf0" stopOpacity="0.88" />
            <stop offset="0.5" stopColor="#aba7f7" stopOpacity="1" />
            <stop offset="0.7" stopColor="#928cf0" stopOpacity="0.88" />
            <stop offset="1" stopColor="#6c62e4" stopOpacity="0.6" />
          </linearGradient>
          {/* Fade the arc's lower ends into the page so it sits behind the chat, not across it */}
          <linearGradient id="arc-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.5" stopColor="white" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <mask id="arc-mask">
            <rect width="1600" height="1000" fill="url(#arc-fade)" />
          </mask>
        </defs>
        {/* Outside to inside: faint violet haze, the tapered lavender band (with a lighter outer rim), a
            saturated blue inner edge, and a blue glow falling off into the dark side. */}
        <g mask="url(#arc-mask)">
          <path d={ARC.haze} fill="none" stroke="url(#arc-g-haze)" strokeOpacity="0.4" strokeWidth="70" filter="url(#arc-glow)" />
          <path d={ARC.inner} fill="none" stroke="url(#arc-g-inner)" strokeOpacity="0.45" strokeWidth="70" filter="url(#arc-glow)" />
          <path d={ARC.band} fill="url(#arc-g-band)" filter="url(#arc-soft)" />
          <path d={ARC.rim} fill="none" stroke="url(#arc-g-rim)" strokeOpacity="0.45" strokeWidth="24" filter="url(#arc-soft)" />
          <path d={ARC.edge} fill="none" stroke="url(#arc-g-edge)" strokeOpacity="0.95" strokeWidth="26" filter="url(#arc-edge)" />
        </g>
      </motion.svg>
    </motion.div>
  );
}
