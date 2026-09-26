// Renders the app icon (web/public/icons) from one SVG. Run with `npm run icons`.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });

// The "route" glyph (lucide) from the header logo: two stops joined by a winding path.
const glyph = (size, scale) => {
  const s = (size * scale) / 24;
  const o = (size - 24 * s) / 2;
  return `<g transform="translate(${o} ${o}) scale(${s})" fill="none" stroke="url(#ink)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/></g>`;
};
const defs = `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2a2a"/><stop offset="1" stop-color="#0d0d0d"/></linearGradient>
  <linearGradient id="ink" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d4d4d4"/></linearGradient>
</defs>`;

// macOS-style: rounded square with transparent margin (Dock icons are ~82% of the canvas).
const rounded = (size) => {
  const m = size * 0.09;
  const w = size - 2 * m;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${defs}
    <rect x="${m}" y="${m}" width="${w}" height="${w}" rx="${w * 0.225}" fill="url(#bg)"/>
    <rect x="${m + 1}" y="${m + 1}" width="${w - 2}" height="${w - 2}" rx="${w * 0.225 - 1}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="${size / 256}"/>
    ${glyph(size, 0.5)}</svg>`;
};
// Full-bleed square for maskable and Apple touch icons (the OS applies its own mask).
const square = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${defs}
  <rect width="${size}" height="${size}" fill="url(#bg)"/>${glyph(size, 0.46)}</svg>`;

const jobs = [
  ['icon-512.png', rounded(512)],
  ['icon-192.png', rounded(192)],
  ['favicon-32.png', rounded(32)],
  ['icon-maskable-512.png', square(512)],
  ['apple-touch-icon.png', square(180)],
];
for (const [name, svg] of jobs) await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL(name, out)));
console.log(`wrote ${jobs.length} icons to web/public/icons`);
