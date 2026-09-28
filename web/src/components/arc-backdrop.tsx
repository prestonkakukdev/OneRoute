import { motion, useReducedMotion } from 'framer-motion';
import { arcBand, arcLine, bandEdge } from '../lib/arc';
import { cn } from '../lib/utils';

// A large glowing arc (a planet's horizon seen from space), drawn in SVG so it stays sharp at any
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
// Chat's arc is violet-blue; Code's is teal, fainter, and pixelated (a mosaic of square cells).
const PALETTES = {
  chat: { haze: '#2e2596', inner: '#3322d6', rim: '#c3bfff', edge: '#5a44ff', band: ['#6c62e4', '#928cf0', '#aba7f7'] },
  code: { haze: '#0b4f47', inner: '#0c8a73', rim: '#b4f5e2', edge: '#18c79d', band: ['#1f8c76', '#3fb89a', '#63d2b4'] },
} as const;

export function ArcBackdrop({ className, variant = 'chat' }: { className?: string; variant?: keyof typeof PALETTES }) {
  const reduceMotion = useReducedMotion();
  const c = PALETTES[variant];
  const id = (name: string) => `arc-${variant}-${name}`;
  const pixel = variant === 'code';
  const CELL = 14; // mosaic cell size, in viewBox units
  return (
    <motion.div
      aria-hidden
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
      initial={{ opacity: 0, scale: 1.04, filter: 'blur(8px)' }}
      animate={{ opacity: pixel ? 0.5 : 1, scale: 1, filter: 'blur(0px)' }}
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
          <filter id={id('soft')} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="12" />
          </filter>
          <filter id={id('edge')} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
          <filter id={id('glow')} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="40" />
          </filter>
          {/* Mosaic: sample the arc at the centre of each cell and grow that sample to fill the cell */}
          <filter id={id('pixel')} filterUnits="userSpaceOnUse" x="250" y="40" width="1100" height="766">
            <feFlood x={250 + CELL / 2 - 1} y={40 + CELL / 2 - 1} width="2" height="2" />
            <feComposite x="250" y="40" width={CELL} height={CELL} />
            <feTile result="grid" />
            <feComposite in="SourceGraphic" in2="grid" operator="in" />
            <feMorphology operator="dilate" radius={CELL / 2} />
          </filter>
          {/* Lighting peaks in the middle of the arc and falls off toward its ends */}
          <Falloff id={id('g-haze')} color={c.haze} edge={0.4} />
          <Falloff id={id('g-inner')} color={c.inner} edge={0.5} />
          <Falloff id={id('g-rim')} color={c.rim} edge={0.25} />
          <Falloff id={id('g-edge')} color={c.edge} edge={0.55} />
          <linearGradient id={id('g-band')} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1600" y2="0">
            <stop offset="0" stopColor={c.band[0]} stopOpacity="0.6" />
            <stop offset="0.3" stopColor={c.band[1]} stopOpacity="0.88" />
            <stop offset="0.5" stopColor={c.band[2]} stopOpacity="1" />
            <stop offset="0.7" stopColor={c.band[1]} stopOpacity="0.88" />
            <stop offset="1" stopColor={c.band[0]} stopOpacity="0.6" />
          </linearGradient>
          {/* Fade the arc's lower ends into the page so it sits behind the content, not across it */}
          <linearGradient id={id('fade')} x1="0" y1="0" x2="0" y2="1">
            <stop offset={pixel ? 0.3 : 0.5} stopColor="white" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <mask id={id('mask')}>
            <rect width="1600" height="1000" fill={`url(#${id('fade')})`} />
          </mask>
        </defs>
        {/* Outside to inside: faint haze, the tapered band (with a lighter outer rim), a saturated inner edge,
            and a glow falling off into the dark side. */}
        <g mask={`url(#${id('mask')})`}>
          <g filter={pixel ? `url(#${id('pixel')})` : undefined}>
            <path d={ARC.haze} fill="none" stroke={`url(#${id('g-haze')})`} strokeOpacity="0.4" strokeWidth="70" filter={`url(#${id('glow')})`} />
            <path d={ARC.inner} fill="none" stroke={`url(#${id('g-inner')})`} strokeOpacity="0.45" strokeWidth="70" filter={`url(#${id('glow')})`} />
            <path d={ARC.band} fill={`url(#${id('g-band')})`} filter={`url(#${id('soft')})`} />
            <path d={ARC.rim} fill="none" stroke={`url(#${id('g-rim')})`} strokeOpacity="0.45" strokeWidth="24" filter={`url(#${id('soft')})`} />
            <path d={ARC.edge} fill="none" stroke={`url(#${id('g-edge')})`} strokeOpacity="0.95" strokeWidth="26" filter={`url(#${id('edge')})`} />
          </g>
        </g>
      </motion.svg>
    </motion.div>
  );
}
