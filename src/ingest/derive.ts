import { DIMENSION_BENCHMARKS, EFFORTS, FULL_EVIDENCE, INDEX_PRIOR_WEIGHT, type Dimension, type Effort } from '../taxonomy.js';

export const ANCHOR = 'artificial_analysis_intelligence_index';
// Equating needs enough models reporting both numbers; below `RELIABLE_PAIRS` it is trusted less.
const MIN_PAIRS = 5;
const RELIABLE_PAIRS = 15;

export interface Equating {
  meanB: number;
  sdB: number;
  meanA: number;
  sdA: number;
  pairs: number;
}

// Linear equating: puts every benchmark on the Intelligence Index scale by matching the mean and
// spread of the two across all variants that report both. Scales differ (fractions, indexes,
// Elo); equated values are directly comparable and averageable.
export function fitEquating(population: Record<string, number>[], minPairs = MIN_PAIRS): Map<string, Equating> {
  const benches = new Set(population.flatMap((v) => Object.keys(v)));
  const out = new Map<string, Equating>();
  for (const b of benches) {
    const pairs = population.filter((v) => v[b] !== undefined && v[ANCHOR] !== undefined);
    if (pairs.length < minPairs) continue;
    const xs = pairs.map((v) => v[b]!);
    const ys = pairs.map((v) => v[ANCHOR]!);
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    const sd = (a: number[], m: number) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) || 1;
    const meanB = mean(xs);
    const meanA = mean(ys);
    out.set(b, { meanB, sdB: sd(xs, meanB), meanA, sdA: sd(ys, meanA), pairs: pairs.length });
  }
  return out;
}

export const equate = (value: number, e: Equating) => e.meanA + ((value - e.meanB) * e.sdA) / e.sdB;

export interface DerivedValue {
  value: number; // Intelligence-Index scale
  trust: number; // 0-1
  benchmarks: string[];
  measured: boolean; // false when no benchmark specific to this capability was available
}

// One model x effort's raw benchmarks -> a value per capability.
// `quality[b]` (0-1) discounts vendor-reported numbers relative to independent ones.
export function deriveDimensions(
  raw: Record<string, number>,
  eq: Map<string, Equating>,
  quality: Record<string, number> = {},
): Partial<Record<Dimension, DerivedValue>> {
  const index = raw[ANCHOR];
  const out: Partial<Record<Dimension, DerivedValue>> = {};
  for (const [dim, weights] of Object.entries(DIMENSION_BENCHMARKS) as [Dimension, Record<string, number>][]) {
    let sum = 0;
    let evidence = 0;
    const used: string[] = [];
    for (const [bench, weight] of Object.entries(weights)) {
      const v = raw[bench];
      const e = eq.get(bench);
      if (v === undefined || !e) continue;
      const w = weight * (quality[bench] ?? 1) * Math.min(1, e.pairs / RELIABLE_PAIRS);
      sum += w * equate(v, e);
      evidence += w;
      used.push(bench);
    }
    if (index === undefined && evidence === 0) continue;
    const k = index === undefined ? 0 : INDEX_PRIOR_WEIGHT;
    out[dim] = {
      value: (sum + k * (index ?? 0)) / (evidence + k),
      trust: Math.round((0.25 + 0.75 * Math.min(1, evidence / FULL_EVIDENCE)) * 100) / 100,
      benchmarks: used.length ? used : [ANCHOR],
      measured: used.length > 0,
    };
  }
  return out;
}

const LADDER = EFFORTS as readonly Effort[];
const rank = (e: Effort) => LADDER.indexOf(e);

// Average effect of each effort level on a dimension, estimated from every model family that was
// measured at two or more effort levels: value(model, effort) = base(model) + effect(effort).
// Returned relative to "high" = 0.
export function fitEffortEffects(families: Map<string, Partial<Record<Effort, number>>>): Partial<Record<Effort, number>> {
  const multi = [...families.values()].filter((f) => Object.keys(f).length >= 2);
  const effect: Partial<Record<Effort, number>> = {};
  const base = new Map<Partial<Record<Effort, number>>, number>();
  for (let iter = 0; iter < 50; iter++) {
    for (const f of multi) {
      const vals = Object.entries(f).map(([e, v]) => v! - (effect[e as Effort] ?? 0));
      base.set(f, vals.reduce((a, b) => a + b, 0) / vals.length);
    }
    const acc: Partial<Record<Effort, { s: number; n: number }>> = {};
    for (const f of multi) {
      for (const [e, v] of Object.entries(f) as [Effort, number][]) {
        const a = (acc[e] ??= { s: 0, n: 0 });
        a.s += v - base.get(f)!;
        a.n++;
      }
    }
    for (const [e, a] of Object.entries(acc) as [Effort, { s: number; n: number }][]) effect[e] = a.s / a.n;
  }
  const ref = effect.high ?? 0;
  for (const e of Object.keys(effect) as Effort[]) effect[e] = effect[e]! - ref;
  // Fill ladder gaps by interpolating between measured neighbours.
  for (const e of LADDER) {
    if (effect[e] !== undefined) continue;
    const lower = LADDER.slice(0, rank(e)).reverse().find((x) => effect[x] !== undefined);
    const upper = LADDER.slice(rank(e) + 1).find((x) => effect[x] !== undefined);
    if (lower && upper) {
      const t = (rank(e) - rank(lower)) / (rank(upper) - rank(lower));
      effect[e] = effect[lower]! + t * (effect[upper]! - effect[lower]!);
    }
  }
  return effect;
}

// Value at an effort AA did not measure: start from the nearest measured effort of the same model
// and add the population's measured difference between the two effort levels.
export function fillEffort(
  measured: Partial<Record<Effort, number>>,
  target: Effort,
  effects: Partial<Record<Effort, number>>,
): { value: number; from: Effort } | undefined {
  const have = (Object.keys(measured) as Effort[]).filter((e) => e !== 'default' && effects[e] !== undefined);
  if (!have.length || effects[target] === undefined || target === 'default') return undefined;
  const from = have.sort((a, b) => Math.abs(rank(a) - rank(target)) - Math.abs(rank(b) - rank(target)))[0]!;
  return { value: measured[from]! + effects[target]! - effects[from]!, from };
}
