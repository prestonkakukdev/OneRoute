import type { Store } from '../db/store.js';
import { parseOpenRouterModel, type OpenRouterModel } from '../providers/openrouter.js';
import { CAPABILITY_KEYS, EFFORTS, INDEX_TO_SKILL, SOURCE_QUALITY, type Capability, type Effort } from '../taxonomy.js';
import type { SkillValue, VariantMetrics } from '../types.js';
import { AA_SOURCE, cleanEvals, matchVariants, metricsOf, parseVariant, type AaModel } from './aa.js';
import { ANCHOR, deriveDimensions, fitEffortEffects, fitEquating, type DerivedValue } from './derive.js';
import { ModelResolver } from './resolve.js';
import type { ExternalResult } from './vendor.js';

const FILLED_TRUST_FACTOR = 0.6;
const ladder: readonly Effort[] = EFFORTS;

export interface PipelineInput {
  aa: AaModel[];
  or: OpenRouterModel[];
  external: ExternalResult[]; // LMArena, vendor reports, ...
  fetchedAt: string;
  minRelease?: string;
  overrides?: Record<string, string>;
}

export interface PipelineReport {
  aaVariants: number;
  models: string[];
  measuredVariants: number;
  filledVariants: number;
  externalRows: number;
  externalUnmatched: number;
  unmatchedAa: { slug: string; name: string; release?: string | null }[];
  disabled: string[];
  benchmarksEquated: number;
  effortEffects: Partial<Record<Capability, Partial<Record<Effort, number>>>>;
}

type Key = `${string}|${Effort}`;
const key = (orId: string, effort: Effort): Key => `${orId}|${effort}`;

interface RawRow {
  orId: string;
  effort: Effort;
  benchmark: string;
  value: number;
  source: string;
  sourceRef?: string;
  independent: boolean;
  measuredAt: string;
}

// Steps 1-2 of the architecture: raw results from every source -> benchmark_results (with provenance)
// -> each benchmark equated onto one scale -> capability values per model x effort -> skills.
export function runPipeline(store: Store, input: PipelineInput): PipelineReport {
  const resolver = new ModelResolver(input.or, input.overrides);
  // Only variants with an Intelligence Index can be placed on the common scale.
  const recentAa = input.aa.filter(
    (v) => cleanEvals(v)[ANCHOR] !== undefined && (!input.minRelease || (v.release_date ?? '') >= input.minRelease),
  );
  const { matches, unmatched } = matchVariants(recentAa, resolver);
  const tracked = new Map<string, { efforts: Effort[] }>();
  for (const m of matches) tracked.set(m.orId, { efforts: m.efforts });

  // 1. Raw rows from every source, attached to (model, effort).
  const rows: RawRow[] = [];
  const metrics = new Map<Key, VariantMetrics>();
  for (const m of matches) {
    for (const [benchmark, value] of Object.entries(cleanEvals(m.aa))) {
      rows.push({
        orId: m.orId,
        effort: m.effort,
        benchmark,
        value,
        source: AA_SOURCE,
        sourceRef: `https://artificialanalysis.ai/models/${parseVariant(m.aa).base}`,
        independent: true,
        measuredAt: input.fetchedAt,
      });
    }
    const vm = metricsOf(m.aa, input.fetchedAt);
    if (vm) metrics.set(key(m.orId, m.effort), vm);
  }
  let externalUnmatched = 0;
  for (const r of input.external) {
    const t = tracked.get(r.orId);
    if (!t) {
      externalUnmatched++;
      continue; // no Artificial Analysis anchor for this model: cannot be placed on the common scale
    }
    const efforts = t.efforts;
    const effort =
      r.effort === 'top' ? efforts[efforts.length - 1]! : r.effort === 'default' ? parseOpenRouterModel(resolver.model(r.orId)!).defaultEffort : r.effort;
    if (!efforts.includes(effort)) {
      externalUnmatched++;
      continue;
    }
    rows.push({ ...r, effort });
  }

  // 2. Group per (model, effort); several sources for one benchmark are averaged, weighted by quality.
  const grouped = new Map<Key, { values: Record<string, number>; quality: Record<string, number> }>();
  const acc = new Map<string, { sum: number; w: number; q: number }>();
  for (const r of rows) {
    const q = r.independent ? SOURCE_QUALITY.independent : SOURCE_QUALITY.vendor;
    const k = `${key(r.orId, r.effort)}#${r.benchmark}`;
    const a = acc.get(k) ?? { sum: 0, w: 0, q: 0 };
    a.sum += r.value * q;
    a.w += q;
    a.q = Math.max(a.q, q);
    acc.set(k, a);
  }
  for (const [k, a] of acc) {
    const [vk, bench] = k.split('#') as [Key, string];
    const g = grouped.get(vk) ?? { values: {}, quality: {} };
    g.values[bench] = a.sum / a.w;
    g.quality[bench] = a.q;
    grouped.set(vk, g);
  }

  // 3. Common scale: AA benchmarks are equated over the whole AA population (hundreds of variants);
  //    other sources over the tracked variants that also have an Intelligence Index.
  const eq = fitEquating(input.aa.map(cleanEvals).filter((v) => v[ANCHOR] !== undefined));
  const aaBenchmarks = new Set(eq.keys());
  const externalEq = fitEquating(
    [...grouped.values()].map((g) =>
      Object.fromEntries(Object.entries(g.values).filter(([b]) => b === ANCHOR || !aaBenchmarks.has(b))),
    ),
  );
  for (const [b, e] of externalEq) if (!aaBenchmarks.has(b)) eq.set(b, e);

  // 4. Measured effect of each effort level per capability, from AA families measured at 2+ efforts.
  const derivedAa = new Map(input.aa.map((v) => [v.id, deriveDimensions(cleanEvals(v), eq)]));
  const families = new Map<string, AaModel[]>();
  for (const v of input.aa) {
    const { base, effort } = parseVariant(v);
    if (effort) families.set(base, [...(families.get(base) ?? []), v]);
  }
  const effortEffects: PipelineReport['effortEffects'] = {};
  for (const cap of CAPABILITY_KEYS) {
    const fam = new Map<string, Partial<Record<Effort, number>>>();
    for (const [base, vs] of families) {
      const perEffort: Partial<Record<Effort, number>> = {};
      for (const v of vs) {
        const d = derivedAa.get(v.id)?.[cap];
        if (d?.measured) perEffort[parseVariant(v).effort!] = d.value;
      }
      fam.set(base, perEffort);
    }
    effortEffects[cap] = fitEffortEffects(fam);
  }
  // Capabilities with no multi-effort data borrow the average curve of the others.
  const generic: Partial<Record<Effort, number>> = {};
  for (const e of Object.keys(effortEffects.reasoning ?? {}) as Effort[]) {
    const vals = CAPABILITY_KEYS.map((c) => effortEffects[c]?.[e]).filter((v): v is number => v !== undefined);
    generic[e] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  for (const cap of CAPABILITY_KEYS) if (Object.keys(effortEffects[cap] ?? {}).length < 3) effortEffects[cap] = generic;
  const indexFamilies = new Map<string, Partial<Record<Effort, number>>>();
  for (const [base, vs] of families) {
    const perEffort: Partial<Record<Effort, number>> = {};
    for (const v of vs) {
      const ii = cleanEvals(v)[ANCHOR];
      if (ii !== undefined) perEffort[parseVariant(v).effort!] = ii;
    }
    indexFamilies.set(base, perEffort);
  }
  const indexEffects = fitEffortEffects(indexFamilies);

  // 5. Per model: every OpenRouter effort x capability gets a value, measured where possible.
  let measuredVariants = 0;
  let filledVariants = 0;
  for (const [orId, t] of tracked) {
    const meta = parseOpenRouterModel(resolver.model(orId)!);
    const derived = new Map<Effort, Partial<Record<Capability, DerivedValue>>>();
    for (const e of t.efforts) {
      const g = grouped.get(key(orId, e));
      if (g) derived.set(e, deriveDimensions(g.values, eq, g.quality));
    }
    // Change in a capability between two effort levels. When the model's own Intelligence Index was
    // measured at both, its own drop is used, scaled by how sensitive this capability is to effort
    // relative to the index across the population; otherwise the population curve.
    const effortDelta = (cap: Capability, from: Effort, to: Effort): number | undefined => {
      const curve = effortEffects[cap] ?? generic;
      if (curve[from] === undefined || curve[to] === undefined) return undefined;
      const pop = curve[to]! - curve[from]!;
      const ownFrom = grouped.get(key(orId, from))?.values[ANCHOR];
      const ownTo = grouped.get(key(orId, to))?.values[ANCHOR];
      const popIndex = (indexEffects[to] ?? 0) - (indexEffects[from] ?? 0);
      if (ownFrom === undefined || ownTo === undefined || Math.abs(popIndex) < 0.5) return pop;
      const sensitivity = Math.min(2, Math.max(0, pop / popIndex));
      return (ownTo - ownFrom) * sensitivity;
    };
    const skillRows: { effort: Effort; dimension: Capability; value: SkillValue }[] = [];
    const toSkill = (d: DerivedValue, source: string, trustFactor = 1): SkillValue => ({
      skill: Math.round(d.value * INDEX_TO_SKILL * 10) / 10,
      source,
      trust: Math.round(d.trust * trustFactor * 100) / 100,
      samples: 0,
      updatedAt: input.fetchedAt,
    });
    for (const effort of t.efforts) {
      if (derived.has(effort)) measuredVariants++;
      else filledVariants++;
      for (const cap of CAPABILITY_KEYS) {
        const here = derived.get(effort)?.[cap];
        // Strongest evidence measured at another effort, moved along the measured effort curve. It wins
        // over this effort's own value when that value rests on weaker benchmarks.
        const moved = [...derived.entries()]
          .filter(([e, d]) => e !== effort && d[cap]?.measured)
          .map(([e, d]) => {
            const delta = effortDelta(cap, e, effort);
            return delta === undefined ? undefined : { from: e, value: d[cap]!.value + delta, d: d[cap]!, trust: d[cap]!.trust * FILLED_TRUST_FACTOR };
          })
          .filter((x) => x !== undefined)
          .sort((a, b) => b.trust - a.trust || Math.abs(ladder.indexOf(a.from) - ladder.indexOf(effort)) - Math.abs(ladder.indexOf(b.from) - ladder.indexOf(effort)))[0];
        if (here?.measured && (!moved || here.trust >= moved.trust)) {
          skillRows.push({ effort, dimension: cap, value: toSkill(here, `measured [${here.benchmarks.join(',')}]`) });
          continue;
        }
        if (moved) {
          skillRows.push({
            effort,
            dimension: cap,
            value: toSkill({ ...moved.d, value: moved.value }, `effort-curve from ${moved.from} [${moved.d.benchmarks.join(',')}]`, FILLED_TRUST_FACTOR),
          });
          continue;
        }
        // No specific benchmark at any effort: the overall index is the only evidence.
        if (here) {
          skillRows.push({ effort, dimension: cap, value: toSkill(here, 'imputed from intelligence index') });
          continue;
        }
        const nearest = [...derived.keys()]
          .filter((e) => derived.get(e)![cap])
          .sort((a, b) => Math.abs(ladder.indexOf(a) - ladder.indexOf(effort)) - Math.abs(ladder.indexOf(b) - ladder.indexOf(effort)))[0];
        const delta = nearest ? effortDelta(cap, nearest, effort) : undefined;
        if (nearest && delta !== undefined) {
          const from = derived.get(nearest)![cap]!;
          skillRows.push({ effort, dimension: cap, value: toSkill({ ...from, value: from.value + delta }, `imputed, effort-curve from ${nearest}`, FILLED_TRUST_FACTOR) });
        }
      }
    }

    const modelMetrics = t.efforts
      .map((e) => ({ effort: e, metrics: metrics.get(key(orId, e)) }))
      .filter((x): x is { effort: Effort; metrics: VariantMetrics } => x.metrics !== undefined);
    const def = modelMetrics.find((x) => x.effort === meta.defaultEffort)?.metrics ?? modelMetrics[0]?.metrics;
    store.upsertModel({
      ...meta,
      enabled: true,
      effortGain: 1,
      tps: def?.tps ?? 80,
      ttftMs: (def?.ttftS ?? 1) * 1000,
      updatedAt: input.fetchedAt,
    });
    store.setEnabled(orId, true);
    if (def?.tps) store.setPerformance(orId, def.tps, (def.ttftS ?? 1) * 1000);
    store.replaceSkills(orId, skillRows);
    store.replaceVariantMetrics(orId, modelMetrics);
    store.replaceAllBenchmarks(orId, rows.filter((x) => x.orId === orId));
  }

  // Models with no independent anchor are switched off rather than routed on guesses.
  const disabled: string[] = [];
  for (const m of store.listModels()) {
    if (!tracked.has(m.id)) {
      store.setEnabled(m.id, false);
      disabled.push(m.id);
    }
  }

  return {
    aaVariants: input.aa.length,
    models: [...tracked.keys()].sort(),
    measuredVariants,
    filledVariants,
    externalRows: input.external.length - externalUnmatched,
    externalUnmatched,
    unmatchedAa: unmatched.map((u) => ({ slug: u.slug, name: u.name, release: u.release_date })),
    disabled,
    benchmarksEquated: eq.size,
    effortEffects,
  };
}
