import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { config } from '../config.js';
import type { Store } from '../db/store.js';
import { chatCompletion, ConfigError } from '../providers/openrouter.js';
import { RoutingError } from '../router/optimizer.js';
import type { Router } from '../router/router.js';
import { MODES, type Mode } from '../taxonomy.js';
import type { ChatRequest, RoutePrefs } from '../types.js';
import { Executor } from './execute.js';

const chatSchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(z.object({ role: z.string() }).loose()).min(1),
    router: z
      .object({
        mode: z.enum(MODES).optional(),
        max_cost_usd: z.number().positive().optional(),
        max_latency_s: z.number().positive().optional(),
        allow_models: z.array(z.string()).optional(),
        deny_models: z.array(z.string()).optional(),
        web: z.enum(['auto', 'on', 'off']).optional(),
        escalation: z.enum(['auto', 'off']).optional(),
        session_id: z.string().max(200).optional(),
      })
      .optional(),
  })
  .loose();

const feedbackSchema = z.object({
  request_id: z.string(),
  success: z.boolean(),
  score: z.number().min(0).max(1).optional(),
  comment: z.string().max(2000).optional(),
});

const AUTO_MODELS = ['auto', ...MODES.map((m) => `auto:${m}`)];
// Large enough for long documents and several images, small enough to protect the process.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

// "auto", "auto:cheap", "router/auto:best" -> routed; anything else is a direct model id.
export function parseAutoModel(model: string | undefined): { auto: boolean; mode?: Mode } {
  const name = (model ?? 'auto').replace(/^router\//, '');
  if (name === 'auto') return { auto: true };
  const m = /^auto:(\w+)$/.exec(name);
  if (m && MODES.includes(m[1] as Mode)) return { auto: true, mode: m[1] as Mode };
  return { auto: false };
}

function openAiError(c: Context, status: number, message: string, type = 'invalid_request_error') {
  return c.json({ error: { message, type } }, status as 400);
}

function keyMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(store: Store, router: Router, executor = new Executor(store), llm = chatCompletion) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.use('/v1/*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => openAiError(c, 413, 'Request body too large') }));
  app.use('/v1/*', async (c, next) => {
    if (!config.gatewayKey) return next();
    const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!keyMatches(given, config.gatewayKey)) return openAiError(c, 401, 'Invalid or missing API key', 'authentication_error');
    return next();
  });

  const parseChat = async (c: Context) => {
    const parsed = chatSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    const body = parsed.data as unknown as ChatRequest & { router?: z.infer<typeof chatSchema>['router'] };
    const r = parsed.data.router;
    const auto = parseAutoModel(body.model);
    const prefs: Partial<RoutePrefs> = {
      mode: auto.mode ?? r?.mode,
      maxCostUsd: r?.max_cost_usd,
      maxLatencyS: r?.max_latency_s,
      allowModels: r?.allow_models,
      denyModels: r?.deny_models,
      web: r?.web,
      escalation: r?.escalation,
      sessionId: r?.session_id ?? c.req.header('x-router-session'),
    };
    return { body, auto, prefs };
  };

  app.post('/v1/chat/completions', async (c) => {
    const parsed = await parseChat(c);
    if ('error' in parsed) return openAiError(c, 400, parsed.error!);
    const { body, auto, prefs } = parsed;

    if (!auto.auto) {
      // Direct model id: plain passthrough, no routing.
      const { router: _r, ...rest } = body;
      const res = await llm(rest, c.req.raw.signal);
      return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
    }
    try {
      const decision = await router.route(body, prefs);
      const result = await executor.execute(body, decision, c.req.raw.signal);
      return result.response;
    } catch (err) {
      if (err instanceof RoutingError) return openAiError(c, 422, err.message, 'routing_error');
      throw err;
    }
  });

  // Decision only: which model + effort, with the reasoning behind it. Nothing is executed.
  app.post('/v1/route', async (c) => {
    const parsed = await parseChat(c);
    if ('error' in parsed) return openAiError(c, 400, parsed.error!);
    try {
      return c.json(await router.route(parsed.body, parsed.prefs));
    } catch (err) {
      if (err instanceof RoutingError) return openAiError(c, 422, err.message, 'routing_error');
      throw err;
    }
  });

  app.post('/v1/feedback', async (c) => {
    const parsed = feedbackSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return openAiError(c, 400, parsed.error.issues.map((i) => i.message).join('; '));
    const { request_id, success, score, comment } = parsed.data;
    if (!store.recordFeedback(request_id, success, score, comment)) return openAiError(c, 404, `Unknown request_id ${request_id}`);
    return c.json({ ok: true });
  });

  app.get('/v1/models', (c) => {
    const created = Math.floor(Date.now() / 1000);
    const data = [
      ...AUTO_MODELS.map((id) => ({ id, object: 'model', created, owned_by: 'router' })),
      ...store.listModels().map((m) => ({ id: m.id, object: 'model', created, owned_by: m.provider })),
    ];
    return c.json({ object: 'list', data });
  });

  app.onError((err, c) => {
    if (err instanceof ConfigError) return openAiError(c, 500, err.message, 'configuration_error');
    console.error(err);
    return openAiError(c, 500, err.message, 'server_error');
  });

  return app;
}
