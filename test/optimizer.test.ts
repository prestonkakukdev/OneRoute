import { beforeEach, describe, expect, it } from 'vitest';
import { buildSeedModels } from '../src/db/seed.js';
import { statKey, type SuccessStat } from '../src/db/store.js';
import { rankCandidates, RoutingError } from '../src/router/optimizer.js';
import { resolvePrefs } from '../src/router/router.js';
import type { ModelRecord, RoutePrefs } from '../src/types.js';
import { facts, makeTask } from './fixtures.js';

let models: ModelRecord[];
const noLearning = { stats: new Map<string, SuccessStat>(), priorStrength: 10, exploration: 'off' as const };
const prefs = (over: Partial<RoutePrefs> = {}): RoutePrefs => ({ ...resolvePrefs({ mode: 'balanced' }), ...over });
const byId = (id: string) => models.find((m) => m.id === id)!;

beforeEach(() => {
  models = buildSeedModels();
});

describe('rankCandidates', () => {
  it('sends a trivial chat message to a cheap, fast model', () => {
    const task = makeTask({ type: 'chat', difficulty: 0, depth: 0, output: 0, latencySensitive: 0.9 });
    const [top] = rankCandidates({ models, task, facts: facts(), prefs: prefs(), learning: noLearning, useWeb: false }).ranked;
    expect(byId(top!.modelId).pricing.inputPerTok * 1e6).toBeLessThan(0.5);
    expect(top!.estLatencyS).toBeLessThan(5);
  });

  it('sends a hard, high-stakes bug to a top-skill model', () => {
    const task = makeTask({ type: 'coding_debug', difficulty: 3, depth: 3, highStakes: 0.8 });
    const [top] = rankCandidates({ models, task, facts: facts(), prefs: prefs(), learning: noLearning, useWeb: false }).ranked;
    expect(byId(top!.modelId).skills.code_debugging!.skill).toBeGreaterThan(75);
    expect(top!.pSuccess).toBeGreaterThan(0.7);
  });

  it('spends more reasoning effort in best mode than in cheap mode on hard math', () => {
    const task = makeTask({ type: 'math', difficulty: 3, depth: 3 });
    const pick = (mode: RoutePrefs['mode']) =>
      rankCandidates({ models, task, facts: facts(), prefs: prefs({ mode }), learning: noLearning, useWeb: false }).ranked[0]!;
    expect(pick('best').estCostUsd).toBeGreaterThan(pick('cheap').estCostUsd);
    expect(pick('best').pSuccess).toBeGreaterThanOrEqual(pick('cheap').pSuccess);
  });

  it('never picks a near-certain failure just because it is cheap', () => {
    const task = makeTask({ type: 'coding_refactor', difficulty: 4, depth: 3, output: 3 });
    const { ranked } = rankCandidates({ models, task, facts: facts(), prefs: prefs({ mode: 'cheap' }), learning: noLearning, useWeb: false });
    const best = Math.max(...ranked.map((c) => c.pSuccess));
    expect(ranked[0]!.pSuccess).toBeGreaterThanOrEqual(best * 0.5);
  });

  it('enforces hard requirements', () => {
    const task = makeTask({ type: 'coding_generate', difficulty: 2 });
    const run = (over: Parameters<typeof facts>[0]) =>
      rankCandidates({ models, task, facts: facts(over), prefs: prefs(), learning: noLearning, useWeb: false });

    const images = run({ hasImages: true });
    for (const c of images.ranked) expect(byId(c.modelId).inputModalities).toContain('image');
    expect(images.rejected['z-ai/glm-5.3']).toBe('no image input');

    const huge = run({ inputTokens: 1_200_000 });
    for (const c of huge.ranked) expect(byId(c.modelId).contextLength).toBeGreaterThan(1_200_000);
    expect(huge.rejected['x-ai/grok-4.7']).toBe('context window too small');
  });

  it('respects allow lists and cost caps, and fails clearly when nothing fits', () => {
    const task = makeTask({ type: 'coding_debug', difficulty: 3 });
    const allowed = rankCandidates({
      models, task, facts: facts(), learning: noLearning, useWeb: false,
      prefs: prefs({ allowModels: ['openai/gpt-6-luna'] }),
    });
    expect(new Set(allowed.ranked.map((c) => c.modelId))).toEqual(new Set(['openai/gpt-6-luna']));

    const capped = rankCandidates({ models, task, facts: facts(), learning: noLearning, useWeb: false, prefs: prefs({ maxCostUsd: 0.002 }) });
    for (const c of capped.ranked) expect(c.estCostUsd).toBeLessThanOrEqual(0.002);

    expect(() =>
      rankCandidates({ models, task, facts: facts(), learning: noLearning, useWeb: false, prefs: prefs({ maxCostUsd: 1e-9 }) }),
    ).toThrow(RoutingError);
  });

  it('learns from feedback: repeated failures push a model down', () => {
    const task = makeTask({ type: 'coding_generate', difficulty: 1, depth: 1 });
    const run = (stats: Map<string, SuccessStat>) =>
      rankCandidates({ models, task, facts: facts(), prefs: prefs(), learning: { ...noLearning, stats }, useWeb: false }).ranked;
    const before = run(new Map())[0]!;
    const stats = new Map<string, SuccessStat>();
    for (const level of [0, 1, 2]) stats.set(statKey(before.modelId, 'coding_generate', level), { successes: 0, trials: 40 });
    const after = run(stats);
    expect(after[0]!.modelId).not.toBe(before.modelId);
    expect(after.find((c) => c.modelId === before.modelId)!.pSuccess).toBeLessThan(before.pSuccess);
  });

  it('prices a session model with its cached prefix', () => {
    const task = makeTask({ type: 'coding_generate', difficulty: 2 });
    const f = facts({ inputTokens: 80_000, prefixTokens: 78_000 });
    const cost = (sticky?: string) =>
      rankCandidates({ models, task, facts: f, prefs: prefs({ allowModels: ['anthropic/claude-opus-5.5'] }), learning: noLearning, useWeb: false, stickyModelId: sticky })
        .ranked.find((c) => c.effort === 'low')!.estCostUsd;
    expect(cost('anthropic/claude-opus-5.5')).toBeLessThan(cost() * 0.5);
  });
});

describe('preferences and value', () => {
  const run = (over: Parameters<typeof resolvePrefs>[0] = {}, task = makeTask({ type: 'coding_debug', difficulty: 2 }), f = facts()) =>
    rankCandidates({ models, task, facts: f, prefs: resolvePrefs({ mode: 'balanced', ...over }), learning: noLearning, useWeb: false }).ranked;

  it('open-weights "only" filters closed models; "prefer" favours open ones', () => {
    for (const m of models) m.openWeights = m.provider === 'z-ai' || m.provider === 'deepseek';
    expect(run({ preferences: { openWeights: 'only' } }).every((c) => byId(c.modelId).openWeights)).toBe(true);
    const preferred = run({ preferences: { openWeights: 'prefer' } })[0]!;
    const neutral = run()[0]!;
    expect(byId(preferred.modelId).openWeights || !byId(neutral.modelId).openWeights).toBe(true);
  });

  it('a higher quality weight buys a better model', () => {
    const cheap = rankCandidates({ models, task: makeTask({ type: 'coding_debug', difficulty: 2 }), facts: facts(), prefs: resolvePrefs({ mode: 'cheap' }), learning: noLearning, useWeb: false }).ranked[0]!;
    const quality = rankCandidates({ models, task: makeTask({ type: 'coding_debug', difficulty: 2 }), facts: facts(), prefs: resolvePrefs({ mode: 'cheap', preferences: { qualityWeight: 20 } }), learning: noLearning, useWeb: false }).ranked[0]!;
    expect(quality.pSuccess).toBeGreaterThan(cheap.pSuccess);
  });

  it('avoided providers lose, and a quality floor removes weak candidates', () => {
    const top = run()[0]!;
    const avoided = run({ preferences: { avoidProviders: [byId(top.modelId).provider] } })[0]!;
    expect(byId(avoided.modelId).provider).not.toBe(byId(top.modelId).provider);
    const floor = run({ preferences: { minQuality: 70 } });
    expect(floor.length).toBeGreaterThan(0);
    expect(floor.length).toBeLessThan(run().length);
  });

  it('bigger jobs justify stronger models', () => {
    const task = makeTask({ type: 'coding_refactor', difficulty: 3, depth: 2 });
    const small = run({}, task, facts({ inputTokens: 2_000 }))[0]!;
    const big = run({}, task, facts({ inputTokens: 200_000 }))[0]!;
    expect(big.pSuccess).toBeGreaterThanOrEqual(small.pSuccess);
  });

  it('answer quality matters even when every model would pass', () => {
    const greeting = makeTask({ type: 'chat', difficulty: 0, depth: 0, output: 0, latencySensitive: 0.9 });
    const base = byId('openai/gpt-6-luna');
    const twin = (id: string, skill: number): ModelRecord => ({
      ...base,
      id,
      skills: { ...base.skills, conversation: { ...base.skills.conversation!, skill } },
    });
    const ranked = rankCandidates({
      models: [twin('x/weak', 25), twin('x/strong', 60)],
      task: greeting,
      facts: facts(),
      prefs: resolvePrefs({ mode: 'balanced' }),
      learning: noLearning,
      useWeb: false,
    }).ranked;
    expect(ranked[0]!.modelId).toBe('x/strong');
  });
});
