import { describe, expect, it } from 'vitest';
import { loadSnapshot } from '../src/db/seed.js';
import { parseOpenRouterModel } from '../src/providers/openrouter.js';
import { buildUpstreamBody, reasoningParam } from '../src/gateway/execute.js';

const snap = new Map(loadSnapshot().map((m) => [m.id, m]));

describe('OpenRouter metadata parsing', () => {
  it('reads effort levels, adding "none" only when reasoning is optional', () => {
    const opus = parseOpenRouterModel(snap.get('anthropic/claude-opus-5.5')!);
    expect(opus.reasoningMandatory).toBe(true);
    expect(opus.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    const sonnet = parseOpenRouterModel(snap.get('anthropic/claude-sonnet-5')!);
    expect(sonnet.efforts[0]).toBe('none');
  });

  it('reads per-token and long-context prices', () => {
    const sol = parseOpenRouterModel(snap.get('openai/gpt-6-sol')!);
    expect(sol.pricing.inputPerTok).toBeCloseTo(2e-6);
    expect(sol.pricing.longContext?.[0]?.minPromptTokens).toBe(272000);
    expect(sol.pricing.webSearchPerCall).toBe(0.01);
  });
});

describe('upstream request', () => {
  it('maps efforts to OpenRouter reasoning params', () => {
    expect(reasoningParam('none')).toEqual({ enabled: false });
    expect(reasoningParam('high')).toEqual({ effort: 'high' });
    expect(reasoningParam('default')).toBeUndefined();
  });

  it('strips router options, sets the model, enables web and Anthropic caching when useful', () => {
    const opus = { provider: 'anthropic' } as never;
    const body = buildUpstreamBody(
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }], router: { mode: 'best' } },
      'anthropic/claude-opus-5.5',
      'low',
      opus,
      { useWeb: true, facts: { prefixTokens: 5000, inputTokens: 6000 } as never },
    );
    expect(body.router).toBeUndefined();
    expect(body.model).toBe('anthropic/claude-opus-5.5');
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.plugins).toEqual([{ id: 'web' }]);
    expect(body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' }); // a conversation: 1-hour cache
    expect(body.usage).toEqual({ include: true });
  });
});

describe('multi-model continuity', () => {
  it('always adds the same note right after any system prompt, so the prompt start never changes between turns', async () => {
    const { continuityNote } = await import('../src/gateway/execute.js');
    const CONTINUITY_NOTE = continuityNote();
    const first = buildUpstreamBody({ messages: [{ role: 'user', content: 'hi' }] }, 'x/y', 'low', undefined, { useWeb: false, facts: { prefixTokens: 0, inputTokens: 5 } as never });
    expect((first.messages as { content: string }[])[0]!.content).toBe(CONTINUITY_NOTE);
    const later = buildUpstreamBody(
      { messages: [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'more' }] },
      'x/y', 'low', undefined, { useWeb: false, facts: { prefixTokens: 10, inputTokens: 20 } as never },
    );
    const msgs = later.messages as { role: string; content: string }[];
    expect(msgs[0]!.content).toBe('be nice');
    expect(msgs[1]).toEqual({ role: 'system', content: CONTINUITY_NOTE });
    expect(msgs).toHaveLength(5);
    expect(CONTINUITY_NOTE).toContain(`today's date is ${new Date().toISOString().slice(0, 10)}`);
    expect(continuityNote({ recentWeb: true })).toContain('did use live web search');
  });
});

describe('prompt caching', () => {
  it('writes a cache from turn 1 of a known conversation, from turn 2 otherwise, and for large one-offs', async () => {
    const { cachePlan } = await import('../src/cache.js');
    const f = (inputTokens: number, prefixTokens = 0) => ({ inputTokens, prefixTokens }) as never;
    expect(cachePlan(f(2000), true)).toEqual({ write: true, ttl: '1h' });
    expect(cachePlan(f(2000), false).write).toBe(false); // one short one-off: no write premium
    expect(cachePlan(f(3000, 1500), false)).toEqual({ write: true, ttl: '1h' }); // turn 2+
    expect(cachePlan(f(8000), false)).toEqual({ write: true, ttl: '5m' }); // large one-off
    expect(cachePlan(f(500), true).write).toBe(false); // below the provider minimum
  });

  it('derives the same conversation id on every turn, and different ids for different callers', async () => {
    const { conversationId } = await import('../src/cache.js');
    const turn1 = [{ role: 'user' as const, content: 'plan my trip' }];
    const turn3 = [...turn1, { role: 'assistant' as const, content: 'sure' }, { role: 'user' as const, content: 'more' }];
    expect(conversationId(turn1, 'a')).toBe(conversationId(turn3, 'a'));
    expect(conversationId(turn1, 'a')).not.toBe(conversationId(turn1, 'b'));
  });

  it('prices staying on a cached model below switching to an equally priced one', async () => {
    const { estimateCost } = await import('../src/router/estimate.js');
    const { buildSeedModels } = await import('../src/db/seed.js');
    const opus = buildSeedModels().find((m) => m.id === 'anthropic/claude-opus-5.5')!;
    opus.pricing.cacheWritePerTok = 5e-6;
    opus.pricing.cacheWrite1hPerTok = 8e-6;
    const facts = { inputTokens: 40_000, prefixTokens: 38_000 } as never;
    const tokens = { input: 40_000, output: 500, reasoning: 0 };
    const stay = estimateCost(opus, tokens, facts, { sticky: true, useWeb: false, cache: { sticky: true, writes: true, ttl: '1h' } });
    const switchIn = estimateCost(opus, tokens, facts, { sticky: false, useWeb: false, cache: { sticky: false, writes: true, ttl: '1h' } });
    const noCache = estimateCost(opus, tokens, facts, { sticky: false, useWeb: false });
    expect(stay).toBeLessThan(noCache / 4); // ~5x cheaper even after the 1-hour write premium on new tokens
    expect(switchIn).toBeGreaterThan(noCache); // switching in pays the full read plus the write premium
  });
});
