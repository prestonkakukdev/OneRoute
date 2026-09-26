import { describe, expect, it } from 'vitest';
import { Store } from '../src/db/store.js';
import { conservativePick, escalateWithLlm, escalationShortlist } from '../src/router/escalate.js';
import type { Candidate } from '../src/types.js';
import { makeTask } from './fixtures.js';

const cand = (modelId: string, effort: string, pSuccess: number, estCostUsd: number, utility: number): Candidate =>
  ({ modelId, effort, pSuccess, estCostUsd, estLatencyS: 10, utility }) as Candidate;

// The real ranking from a Cheap-mode follow-up ("why would the key need to be in the device?"), where the
// old escalation step traded up to Gemini at ~7x the price of the optimizer's pick.
const ranked = [
  cand('deepseek/deepseek-v4.1-flash', 'low', 0.86, 0.00046, 0.0099),
  cand('google/gemini-3.7-flash', 'low', 0.92, 0.00353, 0.0089),
  cand('deepseek/deepseek-v4.1-flash', 'max', 0.94, 0.00098, 0.0087),
  cand('z-ai/glm-5.3-flash', 'low', 0.83, 0.00058, 0.0082),
  cand('openai/gpt-6-luna', 'medium', 0.8, 0.00041, 0.008),
  cand('z-ai/glm-5.3', 'low', 0.89, 0.00314, 0.008),
];

describe('mode-aware escalation', () => {
  it('in Cheap mode, keeps options several times pricier than the optimizer’s pick out of reach', () => {
    const cheap = escalationShortlist(ranked, 'cheap').map((c) => c.modelId);
    // Gemini (~7x the price) and GLM 5.3 are out; the cheap near-top options stay.
    expect(cheap).toEqual(['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash', 'openai/gpt-6-luna']);
    // Balanced is unchanged: the top five models, whatever they cost.
    const balanced = escalationShortlist(ranked, 'balanced').map((c) => c.modelId);
    expect(balanced).toEqual(['deepseek/deepseek-v4.1-flash', 'google/gemini-3.7-flash', 'z-ai/glm-5.3-flash', 'openai/gpt-6-luna', 'z-ai/glm-5.3']);
  });

  it('skips the escalation call when only one option is left', () => {
    const lonely = [cand('a', 'low', 0.9, 0.001, 0.01), cand('b', 'low', 0.95, 0.02, 0.0098), cand('c', 'low', 0.7, 0.0005, 0.005)];
    expect(escalationShortlist(lonely, 'cheap').map((c) => c.modelId)).toEqual(['a']);
  });

  it('tells the escalation model which mode the user chose and marks the optimizer’s pick', async () => {
    const store = new Store(':memory:');
    const models = new Map(store.listModels({ includeDisabled: true }).map((m) => [m.id, m]));
    const known = [...models.keys()].slice(0, 2);
    const list = known.map((id, i) => cand(id, 'low', 0.8 + i * 0.05, 0.001 * (i + 1), 0.01 - i * 0.0005));
    let prompt = '';
    const llm = async (body: unknown) => {
      prompt = (body as { messages: { content: string }[] }).messages[0]!.content;
      return Response.json({ choices: [{ message: { content: '{"candidate":0,"rationale":"cheap and good enough"}' } }] });
    };
    await escalateWithLlm('why?', makeTask({ type: 'chat', difficulty: 1 }), list, models, ['task type unclear'], llm as never, 'cheap');
    expect(prompt).toContain('CHEAP mode');
    expect(prompt).not.toContain('answer quality first');
    expect(prompt).toContain('[0] low effort');
    expect(prompt).toMatch(/\[0\][^\n]*router pick for this mode/);
  });

  it('falls back to the optimizer’s pick in Cheap mode and to the safest near-top option otherwise', () => {
    const list = [cand('a', 'low', 0.8, 0.001, 0.01), cand('b', 'low', 0.95, 0.003, 0.0095)];
    expect(conservativePick(list, 'cheap')).toBe(0);
    expect(conservativePick(list, 'balanced')).toBe(1);
  });
});
