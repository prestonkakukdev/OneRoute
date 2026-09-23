import { describe, expect, it, vi } from 'vitest';
import { classifyHeuristically } from '../src/classifier/heuristic.js';
import { classifyWithJev, JEV_QUESTIONS, JevError } from '../src/classifier/jev.js';
import { buildJevState, clip, estimateTokens, extractFacts } from '../src/classifier/state.js';
import { config } from '../src/config.js';
import type { ChatRequest } from '../src/types.js';

(config as { typesafeKey: string }).typesafeKey = 'test-key';

const jevResponse = {
  model: 'jev-1.13.0',
  answers: {
    task_type: { type: 'choice', choice: 'coding_debug', probabilities: { coding_debug: 0.8, coding_generate: 0.2 }, confidence: 0.7 },
    difficulty: { type: 'score', score: 2.6, probabilities: { '2': 0.4, '3': 0.6 }, confidence: 0.5, legend: {} },
    reasoning_depth: { type: 'score', score: 2, probabilities: { '2': 1 }, confidence: 0.9 },
    output_length: { type: 'score', score: 1, probabilities: { '1': 1 }, confidence: 0.9 },
    needs_web: { type: 'noul', noul: 0.1 },
    latency_sensitive: { type: 'noul', noul: 0.2 },
    high_stakes: { type: 'noul', noul: 0.7 },
  },
  usage: { input_tokens: 300, output_tokens: 20 },
};

describe('Jev questions', () => {
  it('stay within TypeSafe limits', () => {
    for (const q of Object.values(JEV_QUESTIONS)) {
      if (q.type === 'score') expect(q.criteria.length).toBeGreaterThanOrEqual(2), expect(q.criteria.length).toBeLessThanOrEqual(10);
      if (q.type === 'choice') expect(Object.keys(q.criteria).length).toBeLessThanOrEqual(255);
    }
  });
});

describe('classifyWithJev', () => {
  it('sends every question in one call and maps answers to a task profile', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(jevResponse));
    const task = await classifyWithJev({ latest_user_message: 'fix my bug' }, fetchImpl as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(Object.keys(JSON.parse(init!.body as string).questions)).toEqual(Object.keys(JEV_QUESTIONS));
    expect(task.taskType.value).toBe('coding_debug');
    expect(task.difficulty.value).toBe(3);
    expect(task.difficulty.probabilities[0]).toBe(0);
    expect(task.highStakes).toBe(0.7);
    expect(task.source).toBe('jev');
  });

  it('retries once when Jev is overloaded', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 529 }))
      .mockResolvedValueOnce(Response.json(jevResponse));
    await expect(classifyWithJev({}, fetchImpl as typeof fetch)).resolves.toMatchObject({ source: 'jev' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed responses', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ answers: {} }));
    await expect(classifyWithJev({}, fetchImpl as typeof fetch)).rejects.toBeInstanceOf(JevError);
  });
});

describe('request facts and Jev state', () => {
  const req: ChatRequest = {
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this image?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
    tools: [{ type: 'function', function: { name: 'search', parameters: {} } }],
    response_format: { type: 'json_schema', json_schema: {} },
  };

  it('extracts deterministic facts', () => {
    const f = extractFacts(req);
    expect(f).toMatchObject({ hasImages: true, toolsPresent: true, jsonSchemaRequired: true, hasFiles: false });
    expect(f.prefixTokens).toBeGreaterThan(0);
    expect(f.prefixTokens).toBeLessThan(f.inputTokens);
  });

  it('keeps the Jev state small even for huge inputs', () => {
    const big: ChatRequest = { messages: [{ role: 'user', content: 'x'.repeat(2_000_000) }] };
    const state = buildJevState(big, extractFacts(big));
    expect(estimateTokens(JSON.stringify(state))).toBeLessThan(8000);
    const small = buildJevState(req, extractFacts(req));
    expect(small.tools_available).toEqual(['search']);
    expect(small.attachments.images).toBe(1);
  });

  it('clips from the middle', () => {
    const out = clip('a'.repeat(50) + 'b'.repeat(50), 10, 10);
    expect(out.startsWith('a'.repeat(10))).toBe(true);
    expect(out.endsWith('b'.repeat(10))).toBe(true);
  });
});

describe('heuristic fallback', () => {
  it('recognises obvious task types with low confidence', () => {
    const f = extractFacts({ messages: [{ role: 'user', content: 'x' }] });
    expect(classifyHeuristically('I get a TypeError exception when I run this', f).taskType.value).toBe('coding_debug');
    expect(classifyHeuristically('hello!', f).taskType.value).toBe('chat');
    expect(classifyHeuristically('hello!', f).taskType.confidence).toBeLessThan(config.minTaskConfidence);
  });
});
