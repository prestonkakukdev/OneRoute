// Geometry for the landing page's glowing arc (a planet's horizon). The curve is a parabola, not a
// circle: measured off the reference image, its sides keep running outward instead of bending down
// toward vertical like a circle's. The band tapers toward the ends, and the lighting peaks in the
// middle. Everything is in a 1600 x 1000 viewBox.

const CX = 800;
const APEX_Y = 205; // top of the band's centre line
const TOP_RADIUS = 510; // curvature at the top; larger = flatter arc

// Centre line y(x) and its slope.
const y = (x: number) => APEX_Y + (x - CX) ** 2 / (2 * TOP_RADIUS);
const slope = (x: number) => (x - CX) / TOP_RADIUS;

// A point pushed `d` units along the curve's normal (positive = inward, toward the dark side below).
function offset(x: number, d: number): [number, number] {
  const m = slope(x);
  const len = Math.sqrt(1 + m * m);
  return [x - (d * m) / len, y(x) + d / len];
}

// Band thickness: full at the top, tapering to ~55% toward the ends.
const thickness = (x: number) => 92 * (0.55 + 0.45 * Math.exp(-(((x - CX) / 520) ** 2)));

const XS = Array.from({ length: 121 }, (_, i) => -400 + i * 20); // past both edges of the viewBox
const fmt = ([px, py]: [number, number]) => `${px.toFixed(1)},${py.toFixed(1)}`;
const line = (points: [number, number][]) => `M${points.map(fmt).join('L')}`;

/** A line following the curve, `d` units inward (negative = outward), plus `extra(x)` if given. */
export function arcLine(d: number, extra: (x: number) => number = () => 0): string {
  return line(XS.map((x) => offset(x, d + extra(x))));
}

/** The lavender band as a filled shape, so it can taper. */
export function arcBand(): string {
  const outer = XS.map((x) => offset(x, -thickness(x) / 2));
  const inner = [...XS].reverse().map((x) => offset(x, thickness(x) / 2));
  return `${line([...outer, ...inner])}Z`;
}

/** Offsets of the band's edges, for layers that hug them. */
export const bandEdge = (side: 'outer' | 'inner') => (x: number) => (side === 'outer' ? -1 : 1) * (thickness(x) / 2);
