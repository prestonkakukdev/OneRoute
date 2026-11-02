import { readFileSync } from 'node:fs';
import type { Effort } from '../taxonomy.js';

// A benchmark number as reported somewhere, before it is attached to a model x effort in the DB.
export interface ExternalResult {
  orId: string;
  effort: Effort | 'top' | 'default';
  benchmark: string;
  value: number;
  source: string;
  sourceRef?: string;
  independent: boolean;
  measuredAt: string;
}

interface VendorReport {
  source: string;
  url: string;
  reporter: string;
  // Measured by a third party (e.g. Artificial Analysis metrics its free API doesn't include), not the model's maker.
  independent?: boolean;
  published: string;
  models?: string[];
  defaultEffort?: 'top' | 'default';
  rows?: Record<string, (number | null)[]>;
  effortOverrides?: Record<string, Record<string, Effort>>;
  points?: { model: string; effort: Effort; benchmark: string; value: number }[];
}

// Results transcribed into data/vendor-benchmarks.json: vendor release pages, plus third-party measurements marked
// `independent`. Every row keeps its report as the source, so the same model x benchmark reported twice stays as
// two rows.
export function loadVendorResults(file = new URL('../../data/vendor-benchmarks.json', import.meta.url)): ExternalResult[] {
  const { reports } = JSON.parse(readFileSync(file, 'utf8')) as { reports: VendorReport[] };
  const out: ExternalResult[] = [];
  for (const r of reports) {
    const independent = r.independent ?? false;
    const base = { source: independent ? r.source : `vendor:${r.source}`, sourceRef: r.url, independent, measuredAt: r.published };
    for (const [benchmark, values] of Object.entries(r.rows ?? {})) {
      values.forEach((value, i) => {
        const orId = r.models?.[i];
        if (value === null || !orId) return;
        const effort = r.effortOverrides?.[benchmark]?.[orId] ?? r.defaultEffort ?? 'top';
        out.push({ ...base, orId, effort, benchmark, value });
      });
    }
    for (const p of r.points ?? []) out.push({ ...base, orId: p.model, effort: p.effort, benchmark: p.benchmark, value: p.value });
  }
  return out;
}
