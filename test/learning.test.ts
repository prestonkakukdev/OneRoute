import { describe, expect, it } from 'vitest';
import { Store } from '../src/db/store.js';
import { observeAnswer } from '../src/learning/calibration.js';
import { estimateCost, estimateTokens } from '../src/router/estimate.js';
import { Router } from '../src/router/router.js';
import type { TaskProfile } from '../src/types.js';
import { facts, makeTask } from './fixtures.js';

const MODEL = 'openai/gpt-6-luna';

describe('calibration from real answers', () => {
  it('learns that a model writes shorter answers and thinks less, and applies it to estimates', () => {
    const store = new Store(':memory:');
    const task = makeTask({ type: 'writing', difficulty: 2, output: 2 });
    const f = facts({ inputTokens: 400 });
    const model = () => store.listModels().find((m) => m.id === MODEL)!;
    const raw = estimateTokens(task, 'high', f, model(), { calibrated: false });
    for (let i = 0; i < 30; i++) {
      observeAnswer(store, model(), 'high', task, f, {
        promptTokens: 400,
        completionTokens: Math.round(raw.output * 0.4) + Math.round(raw.reasoning * 0.5),
        reasoningTokens: Math.round(raw.reasoning * 0.5),
        latencyMs: 2000,
        useWeb: false,
      });
    }
    const calibrated = estimateTokens(task, 'high', f, model());
    expect(calibrated.output / raw.output).toBeGreaterThan(0.4);
    expect(calibrated.output / raw.output).toBeLessThan(0.6); // pulled most of the way to 0.4x
    expect(calibrated.reasoning).toBeLessThan(raw.reasoning * 0.7);
    expect(model().calibration?.samples).toBe(30);
  });

  it('stays close to the prior after a single odd answer', () => {
    const store = new Store(':memory:');
    const task = makeTask({ type: 'chat', difficulty: 0, output: 1 });
    const model = store.listModels().find((m) => m.id === MODEL)!;
    const raw = estimateTokens(task, 'low', facts(), model, { calibrated: false });
    observeAnswer(store, model, 'low', task, facts(), { promptTokens: 20, completionTokens: raw.output * 10, latencyMs: 1000, useWeb: false });
    const after = estimateTokens(task, 'low', facts(), store.listModels().find((m) => m.id === MODEL)!);
    expect(after.output / raw.output).toBeLessThan(1.6);
  });

  it('learns the real dollar overhead of web search', () => {
    const store = new Store(':memory:');
    const task = makeTask({ type: 'research', difficulty: 1 });
    const f = facts({ inputTokens: 50 });
    const model = () => store.listModels().find((m) => m.id === MODEL)!;
    const tokens = estimateTokens(task, 'low', f, model());
    const before = estimateCost(model(), tokens, f, { sticky: false, useWeb: true });
    // Searches cost 3x the default assumption (e.g. several searches per request).
    const base = (50 + 150) * model().pricing.inputPerTok + 300 * model().pricing.outputPerTok;
    const webDefault = 14000 * model().pricing.inputPerTok + (model().pricing.webSearchPerCall ?? 0.02);
    for (let i = 0; i < 20; i++) {
      observeAnswer(store, model(), 'low', task, f, { promptTokens: 50, completionTokens: 300, latencyMs: 3000, useWeb: true, costUsd: base + 3 * webDefault });
    }
    const after = estimateCost(model(), estimateTokens(task, 'low', f, model()), f, { sticky: false, useWeb: true });
    expect(after).toBeGreaterThan(before * 1.8);
  });
});

describe('feedback inferred from the next message', () => {
  const setup = async (followUp: Partial<TaskProfile>) => {
    const store = new Store(':memory:');
    let next: TaskProfile = makeTask({ type: 'coding_debug', difficulty: 2 });
    const router = new Router(store, { classify: async () => next, llm: async () => new Response('{}', { status: 500 }) });
    const first = await router.route({ messages: [{ role: 'user', content: 'fix my bug' }] }, { sessionId: 's1', escalation: 'off' });
    store.recordOutcome({ requestId: first.requestId, modelId: first.modelId, effort: first.effort, status: 'ok', costUsd: 0.01 });
    next = { ...makeTask({ type: 'coding_debug', difficulty: 2 }), ...followUp };
    const second = await router.route(
      { messages: [{ role: 'user', content: 'fix my bug' }, { role: 'assistant', content: 'try this' }, { role: 'user', content: "that's wrong, it still crashes" }] },
      { sessionId: 's1', escalation: 'off' },
    );
    const row = store.db.prepare('SELECT success, feedback_source FROM outcomes WHERE request_id = ?').get(first.requestId) as Record<string, unknown>;
    return { store, first, second, row };
  };

  it('records "that is wrong" as implicit negative feedback and retries with a different model or higher effort', async () => {
    const { first, second, row } = await setup({ previousRejected: 0.95 });
    expect(row).toEqual({ success: 0, feedback_source: 'implicit' });
    expect(second.implicitFeedback).toMatchObject({ requestId: first.requestId, success: false });
    const same = second.modelId === first.modelId;
    const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    expect(!same || EFFORTS.indexOf(second.effort) > EFFORTS.indexOf(first.effort)).toBe(true);
  });

  it('records confirmation as positive feedback, ignores plain politeness, and never overrides the user', async () => {
    expect((await setup({ previousConfirmed: 0.9 })).row).toEqual({ success: 1, feedback_source: 'implicit' });
    expect((await setup({ previousConfirmed: 0.3 })).row).toEqual({ success: null, feedback_source: null });

    const store = new Store(':memory:');
    store.recordOutcome({ requestId: 'r1', modelId: MODEL, effort: 'low', status: 'ok' });
    store.recordFeedback('r1', true);
    expect(store.recordImplicitFeedback('r1', false, 'x')).toBe(false);
  });

  it('counts implicit feedback at half weight when learning', () => {
    const store = new Store(':memory:');
    const d = { requestId: 'r1', modelId: MODEL, effort: 'low', mode: 'balanced', useWeb: false, task: makeTask({ type: 'chat', difficulty: 0 }), facts: facts(), candidates: [], escalation: null, routeMs: 1 } as never;
    store.recordDecision(d, 'hi');
    store.recordOutcome({ requestId: 'r1', modelId: MODEL, effort: 'low', status: 'ok' });
    store.recordImplicitFeedback('r1', false, 'x');
    const stat = [...store.successStats().values()][0]!;
    expect(stat).toEqual({ successes: 0, trials: 0.5 });
  });
});
