import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/db/store.js';
import { matchVariants, metricsOf, parseVariant, type AaModel } from '../src/ingest/aa.js';
import { arenaResults, parseArenaName, parseArenaPage } from '../src/ingest/lmarena.js';
import { runPipeline } from '../src/ingest/pipeline.js';
import { ModelResolver } from '../src/ingest/resolve.js';
import { loadVendorResults } from '../src/ingest/vendor.js';
import { ANCHOR, deriveDimensions, equate, fillEffort, fitEffortEffects, fitEquating } from '../src/ingest/derive.js';
import { dataHash, generateProfiles } from '../src/ingest/profiles.js';
import type { OpenRouterModel } from '../src/providers/openrouter.js';

const orModel = (id: string, efforts: string[], mandatory = true): OpenRouterModel => ({
  id,
  name: id,
  context_length: 1_000_000,
  architecture: { input_modalities: ['text', 'image'] },
  pricing: { prompt: '0.000002', completion: '0.00001' },
  top_provider: { max_completion_tokens: 64000 },
  supported_parameters: ['tools', 'reasoning', 'structured_outputs'],
  reasoning: { mandatory, supported_efforts: efforts, default_effort: efforts.at(-1) },
});

const aaVariant = (slug: string, name: string, ii: number, extra: Record<string, number> = {}, perf?: [number, number, number]): AaModel => ({
  id: slug,
  slug,
  name,
  release_date: '2026-09-01',
  model_creator: { slug: 'x' },
  evaluations: { [ANCHOR]: ii, ...extra },
  median_output_tokens_per_second: perf?.[0] ?? 0,
  median_time_to_first_token_seconds: perf?.[1] ?? 0,
  median_time_to_first_answer_token: perf?.[2] ?? 0,
});

describe('parseVariant', () => {
  it('reads efforts from the parenthetical only', () => {
    expect(parseVariant({ name: 'Claude Opus 5.5 (Adaptive Reasoning, Xhigh Effort, Default Fallback)', slug: 'claude-opus-5-5-xhigh' })).toMatchObject({ base: 'claude-opus-5-5', effort: 'xhigh' });
    expect(parseVariant({ name: 'Claude Sonnet 5 (Non-reasoning, High Effort)', slug: 'claude-sonnet-5-non-reasoning' })).toMatchObject({ base: 'claude-sonnet-5', effort: 'none' });
    expect(parseVariant({ name: 'GPT-6 Sol (max)', slug: 'gpt-6-sol' })).toMatchObject({ base: 'gpt-6-sol', effort: 'max' });
    // "Max" in a model name is not an effort level.
    expect(parseVariant({ name: 'Qwen3.8 Max (0902)', slug: 'qwen3-8-max' })).toEqual({ base: 'qwen3-8-max', effort: undefined, tag: '0902' });
  });
});

describe('matchVariants', () => {
  const or = [orModel('openai/gpt-6-sol', ['none', 'low', 'high', 'max'], false), orModel('qwen/qwen3.8-max-0902', ['low', 'xhigh']), orModel('deepseek/deepseek-v4-pro-0813', ['high', 'max'])];

  it('pairs AA variants with OpenRouter ids and effort levels', () => {
    const { matches, unmatched } = matchVariants(
      [
        aaVariant('gpt-6-sol', 'GPT-6 Sol (max)', 47),
        aaVariant('gpt-6-sol-low', 'GPT-6 Sol (low)', 34),
        aaVariant('gpt-6-sol-non-reasoning', 'GPT-6 Sol (Non-reasoning)', 28),
        aaVariant('qwen3-8-max', 'Qwen3.8 Max (0902)', 45),
        aaVariant('deepseek-v4-pro', 'DeepSeek V4 Pro (Reasoning, Max Effort)', 36),
        aaVariant('mystery-1', 'Mystery 1', 30),
      ],
      new ModelResolver(or, {}),
    );
    const got = matches.map((m) => `${m.orId}@${m.effort}`).sort();
    expect(got).toEqual([
      'deepseek/deepseek-v4-pro-0813@max',
      'openai/gpt-6-sol@low',
      'openai/gpt-6-sol@max',
      'openai/gpt-6-sol@none',
      'qwen/qwen3.8-max-0902@xhigh', // no effort named -> OpenRouter default effort
    ]);
    expect(unmatched.map((u) => u.slug)).toEqual(['mystery-1']);
  });

  it('honours manual overrides', () => {
    const { matches } = matchVariants([aaVariant('mystery-1', 'Mystery 1', 30)], new ModelResolver(or, { 'mystery-1': 'openai/gpt-6-sol' }));
    expect(matches[0]?.orId).toBe('openai/gpt-6-sol');
  });
});

describe('derivation', () => {
  // Synthetic population: benchmark b is a noiseless linear function of the index.
  const population = Array.from({ length: 60 }, (_, i) => ({ [ANCHOR]: 10 + i, lcr: 0.1 + i * 0.01 }));
  const eq = fitEquating(population);

  it('equates a benchmark onto the index scale', () => {
    expect(equate(0.1 + 30 * 0.01, eq.get('lcr')!)).toBeCloseTo(40, 5);
  });

  it('uses dedicated benchmarks, imputes missing ones with the index, and reports trust by coverage', () => {
    const d = deriveDimensions({ [ANCHOR]: 40, lcr: 0.1 + 50 * 0.01 }, eq);
    expect(d.long_context!.value).toBeGreaterThan(52); // lcr says 60 (weight 2) vs index prior 40 (weight 0.75)
    expect(d.long_context!.benchmarks).toEqual(['lcr']);
    expect(d.long_context!.trust).toBe(1);
    expect(d.long_context!.measured).toBe(true);
    expect(d.software_engineering!.value).toBeLessThan(d.long_context!.value); // lcr is a small share here
    expect(d.agentic_tool_use!.benchmarks).toEqual([ANCHOR]);
    expect(d.agentic_tool_use!.measured).toBe(false);
    expect(d.agentic_tool_use!.trust).toBeLessThan(0.5);
  });

  it('recovers effort effects from families measured at several efforts', () => {
    const effects = { low: -6, medium: -2, high: 0, max: 3 } as const;
    const fam = new Map<string, Record<string, number>>();
    [30, 40, 50].forEach((base, i) => fam.set(`m${i}`, Object.fromEntries(Object.entries(effects).map(([e, d]) => [e, base + d]))));
    fam.set('partial', { low: 20 - 6, max: 20 + 3 });
    const fitted = fitEffortEffects(fam as never);
    for (const [e, d] of Object.entries(effects)) expect(fitted[e as 'low']).toBeCloseTo(d, 1);
    expect(fitted.xhigh).toBeCloseTo(1.5, 1); // interpolated between high and max
    expect(fillEffort({ max: 50 }, 'low', fitted)).toEqual({ value: expect.closeTo(41, 1), from: 'max' });
  });

  it('separates thinking time from base latency', () => {
    // Hidden reasoning: first token == first answer token, includes thinking.
    expect(metricsOf(aaVariant('a', 'A', 1, {}, [72, 18.55, 18.55]), 'now')).toMatchObject({ ttftS: 1, reasoningTokensRef: Math.round(17.55 * 72) });
    // Streamed reasoning: thinking shows up between first token and first answer token.
    expect(metricsOf(aaVariant('b', 'B', 1, {}, [235, 0.78, 9.29]), 'now')).toMatchObject({ ttftS: 0.78, reasoningTokensRef: Math.round(8.51 * 235) });
    expect(metricsOf(aaVariant('c', 'C', 1), 'now')).toBeUndefined();
  });
});

describe('runPipeline', () => {
  const population = (): AaModel[] => {
    const pop: AaModel[] = Array.from({ length: 40 }, (_, i) =>
      aaVariant(`filler-${i}`, `Filler ${i}`, 15 + i, { lcr: 0.2 + i * 0.015, hle: 0.05 + i * 0.01 }),
    );
    // Families measured at several efforts teach the effort curve.
    for (const [k, base] of [['fa', 30], ['fb', 40], ['fc', 50]] as const) {
      pop.push(aaVariant(`${k}-low`, `${k} (low)`, base - 6, { hle: (base - 6) / 100 }));
      pop.push(aaVariant(`${k}-high`, `${k} (high)`, base, { hle: base / 100 }));
      pop.push(aaVariant(`${k}`, `${k} (max)`, base + 3, { hle: (base + 3) / 100 }));
    }
    return pop;
  };

  it('writes raw benchmarks with provenance, per-effort skills (measured and curve-filled) and speed', () => {
    const store = new Store(':memory:');
    const aa = [...population(), aaVariant('gpt-6-sol', 'GPT-6 Sol (max)', 47, { hle: 0.45, lcr: 0.7 }, [107, 95.6, 95.6])];
    const or = [orModel('openai/gpt-6-sol', ['low', 'high', 'max'])];
    const report = runPipeline(store, { aa, or, external: [], fetchedAt: '2026-09-23T00:00:00Z', overrides: {} });

    expect(report.models).toEqual(['openai/gpt-6-sol']);
    expect(report.measuredVariants).toBe(1);
    expect(report.filledVariants).toBe(2);
    const m = store.listModels().find((x) => x.id === 'openai/gpt-6-sol')!;
    expect(m.variantSkills.max!.reasoning!.source).toContain('measured');
    expect(m.variantSkills.low!.reasoning!.source).toContain('effort-curve from max');
    expect(m.variantSkills.low!.reasoning!.skill).toBeLessThan(m.variantSkills.high!.reasoning!.skill);
    expect(m.variantSkills.high!.reasoning!.skill).toBeLessThan(m.variantSkills.max!.reasoning!.skill);
    expect(m.variantMetrics.max).toMatchObject({ tps: 107, ttftS: 1 });
    expect(store.benchmarks('openai/gpt-6-sol').map((b) => b.benchmark).sort()).toEqual([ANCHOR, 'hle', 'lcr']);
  });

  it('places vendor and arena results on the common scale and weights them by source quality', () => {
    const store = new Store(':memory:');
    const models = ['a', 'b', 'c', 'd', 'e', 'f'];
    const aa = [...population(), ...models.map((k, i) => aaVariant(`m-${k}`, `M ${k} (max)`, 30 + i * 5, { hle: 0.3 + i * 0.05 }))];
    const or = models.map((k) => orModel(`x/m-${k}`, ['low', 'max']));
    const external = models.flatMap((k, i) => [
      { orId: `x/m-${k}`, effort: 'top' as const, benchmark: 'osworld_2', value: 40 + i * 8, source: 'vendor:test', independent: false, measuredAt: 'now' },
      { orId: `x/m-${k}`, effort: 'max' as const, benchmark: 'lmarena_creative_writing', value: 1400 + i * 20, source: 'lmarena.ai', independent: true, measuredAt: 'now' },
    ]);
    const report = runPipeline(store, { aa, or, external, fetchedAt: 'now', overrides: {} });
    expect(report.externalRows).toBe(12);
    const byId = new Map(store.listModels().map((m) => [m.id, m]));
    const best = byId.get('x/m-f')!.variantSkills.max!;
    const worst = byId.get('x/m-a')!.variantSkills.max!;
    expect(best.computer_use!.source).toContain('osworld_2');
    expect(best.computer_use!.skill).toBeGreaterThan(worst.computer_use!.skill);
    expect(best.writing!.source).toContain('lmarena_creative_writing');
    // Independent arena data earns more trust than a vendor-reported benchmark of similar weight.
    expect(best.writing!.trust).toBeGreaterThan(best.computer_use!.trust);
    expect(store.benchmarks('x/m-f').some((b) => b.source === 'vendor:test')).toBe(true);
  });
});

describe('sources', () => {
  it('parses LMArena names and embedded ratings', () => {
    expect(parseArenaName('claude-opus-5-high')).toEqual({ base: 'claude-opus-5', effort: 'high' });
    expect(parseArenaName('muse-spark-1.2 (xHigh)')).toEqual({ base: 'muse-spark-1-2', effort: 'xhigh' });
    expect(parseArenaName('deepseek-v4-pro-high-20260813')).toEqual({ base: 'deepseek-v4-pro', effort: 'high' });
    expect(parseArenaName('qwen3.8-max')).toEqual({ base: 'qwen3-8', effort: 'max' }); // resolved as a full name below
    const html = '\\"modelDisplayName\\":\\"gpt-6-sol-xhigh\\",\\"rating\\":1483.2,\\"ratingUpper\\":1490.1,\\"ratingLower\\":1476.3,\\"votes\\":27069';
    expect(parseArenaPage(html)).toEqual([{ name: 'gpt-6-sol-xhigh', rating: 1483.2, upper: 1490.1, lower: 1476.3, votes: 27069 }]);
    const resolver = new ModelResolver([orModel('openai/gpt-6-sol', ['low', 'xhigh']), orModel('qwen/qwen3.8-max-0902', ['low', 'xhigh'])], {});
    const { results } = arenaResults('lmarena_text', parseArenaPage(html), resolver, 'now');
    expect(results[0]).toMatchObject({ orId: 'openai/gpt-6-sol', effort: 'xhigh', value: 1483.2, independent: true });
    const qwen = arenaResults('lmarena_text', [{ name: 'qwen3.8-max', rating: 1481, lower: 1475, upper: 1487, votes: 16670 }], resolver, 'now');
    expect(qwen.results[0]).toMatchObject({ orId: 'qwen/qwen3.8-max-0902', effort: 'xhigh' });
  });

  it('loads every vendor report row with its source and effort', () => {
    const rows = loadVendorResults();
    expect(rows.every((r) => !r.independent && r.source.startsWith('vendor:') && r.sourceRef)).toBe(true);
    expect(rows.find((r) => r.orId === 'anthropic/claude-opus-5.5' && r.benchmark === 'terminalbench_4')).toMatchObject({ effort: 'xhigh', value: 66.4 });
    expect(rows.find((r) => r.orId === 'openai/gpt-6-sol' && r.benchmark === 'osworld_2')).toMatchObject({ effort: 'xhigh', value: 60.5 });
  });
});

describe('profiles', () => {
  it('regenerates only when a model\'s data changes', async () => {
    const store = new Store(':memory:');
    const llm = vi.fn(async () => Response.json({ choices: [{ message: { content: 'Strong at math, cheap.' } }] }));
    const first = await generateProfiles(store, { llm });
    expect(first.generated.length).toBe(store.listModels().length);
    expect(store.listModels()[0]!.profile).toBe('Strong at math, cheap.');

    const second = await generateProfiles(store, { llm });
    expect(second.generated).toHaveLength(0);
    expect(second.unchanged).toBe(first.generated.length);

    const m = store.listModels()[0]!;
    const before = dataHash(m);
    store.upsertModel({ ...m, pricing: { ...m.pricing, inputPerTok: m.pricing.inputPerTok * 2 } });
    const changed = store.listModels().find((x) => x.id === m.id)!;
    expect(dataHash(changed)).not.toBe(before);
    const third = await generateProfiles(store, { llm });
    expect(third.generated).toEqual([m.id]);
  });
});

describe('reliability', () => {
  it('trusts live uptime only once a model has a track record', async () => {
    const { reliability } = await import('../src/router/estimate.js');
    const base = { providerStats: { tps: 100, latencyS: 1, uptime: 1, providers: 1, requests: 1, measuredAt: 'now' } } as never;
    const proven = { providerStats: { tps: 100, latencyS: 1, uptime: 0.999, providers: 5, requests: 100_000, measuredAt: 'now' } } as never;
    expect(reliability(base)).toBeLessThan(reliability(proven)); // 1 perfect request is not proof
  });
});
