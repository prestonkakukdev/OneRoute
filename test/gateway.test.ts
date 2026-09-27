import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { Executor } from '../src/gateway/execute.js';
import { createApp, parseAutoModel } from '../src/gateway/server.js';
import { Router } from '../src/router/router.js';
import type { TaskProfile } from '../src/types.js';
import { makeTask } from './fixtures.js';

type Llm = (body: unknown, signal?: AbortSignal) => Promise<Response>;

function completion(model: string) {
  return {
    id: 'gen-1',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 },
  };
}

function sse(model: string): Response {
  const events = [
    { id: 'gen-1', model, choices: [{ delta: { content: 'hel' } }] },
    { id: 'gen-1', model, choices: [{ delta: { content: 'lo' } }] },
    { id: 'gen-1', model, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.00005 } },
  ];
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new Blob([text]).stream(), { headers: { 'content-type': 'text/event-stream' } });
}

const okLlm: Llm = async (body) => {
  const b = body as { model: string; stream?: boolean };
  return b.stream ? sse(b.model) : Response.json(completion(b.model));
};

function setup(opts: { task?: TaskProfile; llm?: Llm; classify?: () => Promise<TaskProfile> } = {}) {
  const store = new Store(':memory:');
  const llm = vi.fn(opts.llm ?? okLlm);
  const classify = opts.classify ?? (async () => opts.task ?? makeTask({ type: 'chat', difficulty: 0, depth: 0, output: 0 }));
  const router = new Router(store, { classify, llm });
  const app = createApp(store, router, new Executor(store, llm), llm);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { store, llm, app, post };
}

const chat = { model: 'auto', messages: [{ role: 'user', content: 'hi there' }] };

describe('parseAutoModel', () => {
  it('recognises routed model names', () => {
    expect(parseAutoModel(undefined)).toEqual({ auto: true });
    expect(parseAutoModel('auto:best')).toEqual({ auto: true, mode: 'best' });
    expect(parseAutoModel('router/auto:cheap')).toEqual({ auto: true, mode: 'cheap' });
    expect(parseAutoModel('openai/gpt-6-sol')).toEqual({ auto: false });
  });
});

describe('POST /v1/chat/completions', () => {
  it('routes, calls the chosen model and reports what it did', async () => {
    const { post, store, llm } = setup();
    const res = await post('/v1/chat/completions', chat);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { router: { request_id: string; model: string; task_type: string }; choices: unknown[] };
    expect(body.choices).toHaveLength(1);
    expect(body.router.task_type).toBe('chat');
    expect(res.headers.get('x-router-model')).toBe(body.router.model);
    const sent = llm.mock.calls[0]![0] as { model: string; router?: unknown };
    expect(sent.model).toBe(body.router.model);
    expect(sent.router).toBeUndefined();
    expect(store.summary()[0]).toMatchObject({ model: body.router.model, requests: 1, errors: 0 });
  });

  it('streams the upstream events through untouched and logs usage at the end', async () => {
    const { post, store } = setup();
    const res = await post('/v1/chat/completions', { ...chat, stream: true });
    const text = await res.text();
    expect(text).toContain('"content":"hel"');
    expect(text).toContain('[DONE]');
    const row = store.db.prepare('SELECT status, cost_usd, completion_tokens FROM outcomes').get() as Record<string, unknown>;
    expect(row).toMatchObject({ status: 'ok', cost_usd: 0.00005, completion_tokens: 2 });
  });

  it('falls back to the next model when the first one is down', async () => {
    let calls = 0;
    const { post } = setup({
      llm: async (body) => (calls++ === 0 ? new Response('overloaded', { status: 503 }) : okLlm(body)),
    });
    const res = await post('/v1/chat/completions', chat);
    const body = (await res.json()) as { router: { fallbacks: number; model: string } };
    expect(res.status).toBe(200);
    expect(body.router.fallbacks).toBe(1);
  });

  it('does not fall back on account errors', async () => {
    const { post, llm } = setup({ llm: async () => new Response('{"error":{"message":"no credits"}}', { status: 402 }) });
    const res = await post('/v1/chat/completions', chat);
    expect(res.status).toBe(402);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('passes explicit model ids straight through without routing', async () => {
    const { post, llm, store } = setup();
    const res = await post('/v1/chat/completions', { ...chat, model: 'openai/gpt-6-sol' });
    expect(((await res.json()) as { model: string }).model).toBe('openai/gpt-6-sol');
    expect((llm.mock.calls[0]![0] as { model: string }).model).toBe('openai/gpt-6-sol');
    expect(store.summary()).toHaveLength(0);
  });

  it('validates the request', async () => {
    const { post } = setup();
    const res = await post('/v1/chat/completions', { model: 'auto', messages: [] });
    expect(res.status).toBe(400);
  });
});

describe('routing endpoints', () => {
  it('POST /v1/route returns the decision without calling a model', async () => {
    const { post, llm } = setup({ task: makeTask({ type: 'coding_debug', difficulty: 3, highStakes: 0.8 }) });
    const res = await post('/v1/route', { ...chat, router: { mode: 'best' } });
    const d = (await res.json()) as { mode: string; modelId: string; candidates: unknown[] };
    expect(d.mode).toBe('best');
    expect(d.candidates.length).toBeGreaterThan(1);
    expect(llm).not.toHaveBeenCalled();
  });

  it('escalates an unclear request to the LLM, which can only pick from the shortlist', async () => {
    const pick = { choices: [{ message: { content: JSON.stringify({ candidate: 1, rationale: 'second is safer' }) } }] };
    const { post, llm } = setup({
      task: makeTask({ type: 'reasoning', difficulty: 2, typeP: 0.3, diffP: 0.3 }),
      llm: async () => Response.json(pick),
    });
    const d = (await (await post('/v1/route', chat)).json()) as {
      escalation: { by: string; rationale: string };
      modelId: string;
      candidates: { modelId: string }[];
    };
    expect(llm).toHaveBeenCalledTimes(1);
    expect(d.escalation.by).toBe('llm');
    expect(d.escalation.rationale).toBe('second is safer');
    expect(d.candidates[0]!.modelId).toBe(d.modelId);
  });

  it('falls back to a conservative pick when the escalation model fails', async () => {
    const { post } = setup({
      task: makeTask({ type: 'reasoning', difficulty: 2, typeP: 0.3 }),
      llm: async () => new Response('down', { status: 500 }),
    });
    const d = (await (await post('/v1/route', chat)).json()) as { escalation: { by: string } };
    expect(d.escalation.by).toBe('conservative');
  });

  it('uses the keyword fallback when Jev is unavailable', async () => {
    const { post } = setup({
      classify: async () => {
        throw new Error('jev down');
      },
    });
    const d = (await (await post('/v1/route', { ...chat, router: { escalation: 'off' } })).json()) as { task: TaskProfile };
    expect(d.task.source).toBe('heuristic');
    expect(d.task.error).toBe('jev down');
  });

  it('records feedback for known requests only', async () => {
    const { post } = setup();
    const done = (await (await post('/v1/chat/completions', chat)).json()) as { router: { request_id: string } };
    expect((await post('/v1/feedback', { request_id: done.router.request_id, success: false })).status).toBe(200);
    expect((await post('/v1/feedback', { request_id: 'nope', success: true })).status).toBe(404);
  });

  it('keeps a session on one model so its prompt cache is reused', async () => {
    const { post, store } = setup({ task: makeTask({ type: 'coding_generate', difficulty: 2 }) });
    const r1 = (await (await post('/v1/chat/completions', { ...chat, router: { session_id: 's1' } })).json()) as { router: { model: string } };
    expect(store.getSession('s1')?.modelId).toBe(r1.router.model);
    const d2 = (await (await post('/v1/route', { ...chat, router: { session_id: 's1' } })).json()) as { stickyModel: string };
    expect(d2.stickyModel).toBe(r1.router.model);
  });
});

describe('GET /v1/models and auth', () => {
  afterEach(() => {
    (config as { gatewayKey: string }).gatewayKey = '';
  });

  it('lists auto models and tracked models', async () => {
    const { app } = setup();
    const ids = ((await (await app.request('/v1/models')).json()) as { data: { id: string }[] }).data.map((m) => m.id);
    expect(ids).toContain('auto:cheap');
    expect(ids).toContain('anthropic/claude-opus-5.5');
  });

  it('requires the gateway key when one is configured', async () => {
    (config as { gatewayKey: string }).gatewayKey = 'secret';
    const { app } = setup();
    expect((await app.request('/v1/models')).status).toBe(401);
    expect((await app.request('/v1/models', { headers: { authorization: 'Bearer secret' } })).status).toBe(200);
    expect((await app.request('/health')).status).toBe(200);
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('configuration errors', () => {
  it('fails once with a clear message instead of trying every model', async () => {
    const { ConfigError } = await import('../src/providers/openrouter.js');
    const { post, llm } = setup({
      llm: async () => {
        throw new ConfigError('OPENROUTER_API_KEY is not set (add it to .env).');
      },
    });
    const res = await post('/v1/chat/completions', { ...chat, router: { escalation: 'off' } });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('OPENROUTER_API_KEY');
    expect(llm).toHaveBeenCalledTimes(1);
  });
});

describe('web search decision', () => {
  it('follows the same web-research weight used to choose the model', async () => {
    const { webDecision, resolvePrefs } = await import('../src/router/router.js');
    const { facts } = await import('./fixtures.js');
    // "dive deep into CRISPR": research 55%, low needs-current-info, modest Jev importance.
    const task = makeTask({ type: 'research', difficulty: 2, typeP: 0.55, capabilities: { web_research: 0.26 } });
    task.needsWeb = 0.18;
    expect(webDecision(task, facts(), resolvePrefs({})).on).toBe(true);
    const chat = makeTask({ type: 'chat', difficulty: 0 });
    chat.needsWeb = 0.05;
    expect(webDecision(chat, facts(), resolvePrefs({})).on).toBe(false);
    expect(webDecision(task, facts({ toolsPresent: true }), resolvePrefs({})).on).toBe(false);
    expect(webDecision(chat, facts(), resolvePrefs({ web: 'on' })).reason).toContain('your setting');
    // "explain number 4" after a web-search answer keeps search on; "thanks!" does not.
    const followUp = makeTask({ type: 'extraction', difficulty: 1 });
    followUp.needsWeb = 0.25;
    expect(webDecision(followUp, facts(), resolvePrefs({}), true)).toEqual({ on: true, reason: 'follow-up to a web-search answer' });
    expect(webDecision(followUp, facts(), resolvePrefs({}), false).on).toBe(false);
    chat.needsWeb = 0.03;
    expect(webDecision(chat, facts(), resolvePrefs({}), true).on).toBe(false);
  });
});

describe('saved chats', () => {
  it('saves turns in order, updates a turn in place, lists, renames and deletes chats', async () => {
    const { app } = setup();
    const put = (chatId: string, turn: Record<string, unknown>, title = 'first question') =>
      app.request(`/ui/api/chats/${chatId}/turns/${turn.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, turn }) });

    expect((await put('c1', { id: 't1', prompt: 'first question', answer: 'a1' })).status).toBe(200);
    await put('c1', { id: 't2', prompt: 'second', answer: 'a2' }, 'ignored for an existing chat');
    await put('c1', { id: 't1', prompt: 'first question', answer: 'a1', feedback: 'Recorded 👍' });
    await put('c2', { id: 't1', prompt: 'other chat' }, 'other chat');

    const c1 = (await (await app.request('/ui/api/chats/c1')).json()) as { title: string; turns: { id: string; feedback?: string }[] };
    expect(c1.title).toBe('first question');
    expect(c1.turns.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(c1.turns[0]!.feedback).toBe('Recorded 👍');

    const list = (await (await app.request('/ui/api/chats')).json()) as { id: string; turns: number }[];
    expect(list.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    expect(list.find((c) => c.id === 'c1')!.turns).toBe(2);

    await app.request('/ui/api/chats/c1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Renamed' }) });
    expect(((await (await app.request('/ui/api/chats/c1')).json()) as { title: string }).title).toBe('Renamed');

    expect((await app.request('/ui/api/chats/c1', { method: 'DELETE' })).status).toBe(200);
    expect((await app.request('/ui/api/chats/c1')).status).toBe(404);
    expect((await put('c3', { id: 'mismatch' }).then(() => app.request('/ui/api/chats/c3/turns/other', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x', turn: { id: 'nope' } }) }))).status).toBe(400);
  });
});

describe('saved chat titles', () => {
  it('saves a chat whose first message is very long, shortening the title', async () => {
    const { app, store } = setup();
    const long = 'So ive been hearing a lot about autonomous agents causing problems. '.repeat(20);
    const res = await app.request('/ui/api/chats/c-long/turns/t1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: long, turn: { id: 't1', prompt: long } }),
    });
    expect(res.status).toBe(200);
    expect(store.getChat('c-long')!.title.length).toBeLessThanOrEqual(120);
  });
});
