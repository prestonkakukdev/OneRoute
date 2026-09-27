// Renders the OneRoute arc (the same geometry as the app's landing backdrop) to static images for the
// site: the plan-card artwork and the social-share preview. Run: npx tsx site/scripts/arc-image.ts
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { arcBand, arcLine, bandEdge } from '../../web/src/lib/arc.ts';

const falloff = (id: string, color: string, edge: number) => `
  <linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1600" y2="0">
    <stop offset="0" stop-color="${color}" stop-opacity="${edge}"/>
    <stop offset="0.5" stop-color="${color}" stop-opacity="1"/>
    <stop offset="1" stop-color="${color}" stop-opacity="${edge}"/>
  </linearGradient>`;

function arcSvg(viewBox: string, width: number, height: number, background = '#000000'): string {
  const [x, y, w, h] = viewBox.split(' ').map(Number);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice">
  <defs>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="12"/></filter>
    <filter id="edge" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>
    ${falloff('haze', '#2e2596', 0.4)}${falloff('inner', '#3322d6', 0.5)}${falloff('rim', '#c3bfff', 0.25)}${falloff('edgeg', '#5a44ff', 0.55)}
    <linearGradient id="band" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1600" y2="0">
      <stop offset="0" stop-color="#6c62e4" stop-opacity="0.6"/><stop offset="0.3" stop-color="#928cf0" stop-opacity="0.88"/>
      <stop offset="0.5" stop-color="#aba7f7" stop-opacity="1"/><stop offset="0.7" stop-color="#928cf0" stop-opacity="0.88"/>
      <stop offset="1" stop-color="#6c62e4" stop-opacity="0.6"/>
    </linearGradient>
  </defs>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${background}"/>
  <path d="${arcLine(-30, bandEdge('outer'))}" fill="none" stroke="url(#haze)" stroke-opacity="0.4" stroke-width="70" filter="url(#glow)"/>
  <path d="${arcLine(30, bandEdge('inner'))}" fill="none" stroke="url(#inner)" stroke-opacity="0.45" stroke-width="70" filter="url(#glow)"/>
  <path d="${arcBand()}" fill="url(#band)" filter="url(#soft)"/>
  <path d="${arcLine(14, bandEdge('outer'))}" fill="none" stroke="url(#rim)" stroke-opacity="0.45" stroke-width="24" filter="url(#soft)"/>
  <path d="${arcLine(0, bandEdge('inner'))}" fill="none" stroke="url(#edgeg)" stroke-opacity="0.95" stroke-width="26" filter="url(#edge)"/>
</svg>`;
}

const out = (name: string) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));
// Plan cards: the arc's crest, framed like the reference artwork.
await sharp(Buffer.from(arcSvg('250 40 1100 766', 1200, 836))).webp({ quality: 88 }).toFile(out('arc-card.webp'));
// Social-share preview (1200x630), on the site's background colour.
await sharp(Buffer.from(arcSvg('200 20 1200 630', 1200, 630, '#0a0a0a'))).png().toFile(out('og.png'));
console.log('wrote site/public/arc-card.webp and site/public/og.png');
