// Keeping the capability scale stable across Artificial Analysis index versions.
//
// Every capability value is on the scale of AA's Intelligence Index (see derive.ts), and the router's difficulty
// and success curves are calibrated to it. In October 2026 AA replaced the v4 series with Intelligence Index v5:
// different benchmarks, a wider spread (v4 13 -> v5 6, v4 57.6 -> v5 58.4), and only recent models re-scored, so
// the free API now reports v5 for ~90 variants and no index at all for the rest. Routing on v5 would rescale every
// model; dropping models without it would disable most of the catalog.
//
// So the anchor stays the v4 series. data/aa-index-v4.json keeps the v4 values last published for each AA variant,
// v5 becomes an ordinary benchmark (`aa_intelligence_index_v5`), and a variant without a v4 value gets one estimated
// from its other AA benchmarks, each equated onto the v4 scale and weighted by how well it tracks it. Checked
// leave-one-out over the 190 variants with both: mean error 2.1 index points.

import { readFileSync } from 'node:fs';
import type { AaModel } from './aa.js';
import { cleanEvals } from './aa.js';
import { ANCHOR, equate, fitEquating, RELIABLE_PAIRS } from './derive.js';

export const INDEX_V5 = 'aa_intelligence_index_v5';
export const LEGACY_INDEX_FILE = new URL('../../data/aa-index-v4.json', import.meta.url);

// A benchmark counts towards an estimate only if it tracks the index this well.
const MIN_R = 0.5;
// An estimate needs v5 or at least this many other benchmarks.
const MIN_BENCHMARKS = 3;

export type LegacyIndex = Record<string, Record<string, number>>; // AA slug -> v4 index fields

export function loadLegacyIndex(file: URL = LEGACY_INDEX_FILE): LegacyIndex {
  return (JSON.parse(readFileSync(file, 'utf8')) as { variants: LegacyIndex }).variants;
}

// AA variants with their index on the v4 scale: published, or estimated (ids in `estimated`). Variants with too
// little data for an estimate keep no index and stay untracked.
export function onLegacyScale(aa: AaModel[], legacy: LegacyIndex): { aa: AaModel[]; estimated: Set<string> } {
  const evals = new Map<string, Record<string, number>>();
  for (const v of aa) {
    const e = cleanEvals(v);
    if (e[ANCHOR] !== undefined) {
      e[INDEX_V5] = e[ANCHOR];
      delete e[ANCHOR];
    }
    for (const [b, value] of Object.entries(legacy[v.slug] ?? {})) e[b] ??= value;
    evals.set(v.id, e);
  }
  const eq = fitEquating([...evals.values()].filter((e) => e[ANCHOR] !== undefined));
  const estimated = new Set<string>();
  for (const [id, e] of evals) {
    if (e[ANCHOR] !== undefined) continue;
    let sum = 0;
    let weight = 0;
    let used = 0;
    for (const [b, value] of Object.entries(e)) {
      const fit = eq.get(b);
      if (!fit || fit.r < MIN_R) continue;
      const w = ((fit.r * fit.r) / (1 - fit.r * fit.r + 1e-3)) * Math.min(1, fit.pairs / RELIABLE_PAIRS);
      sum += w * equate(value, fit);
      weight += w;
      used++;
    }
    if (!weight || (e[INDEX_V5] === undefined && used < MIN_BENCHMARKS)) continue;
    e[ANCHOR] = Math.round((sum / weight) * 10) / 10;
    estimated.add(id);
  }
  return { aa: aa.map((v) => ({ ...v, evaluations: evals.get(v.id) })), estimated };
}
