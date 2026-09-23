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
      { useWeb: true, facts: { prefixTokens: 5000 } as never },
    );
    expect(body.router).toBeUndefined();
    expect(body.model).toBe('anthropic/claude-opus-5.5');
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.plugins).toEqual([{ id: 'web' }]);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.usage).toEqual({ include: true });
  });
});
