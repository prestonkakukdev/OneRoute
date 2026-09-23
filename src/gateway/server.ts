import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { config } from '../config.js';
import type { Store } from '../db/store.js';
import { chatCompletion, ConfigError } from '../providers/openrouter.js';
import { RoutingError } from '../router/optimizer.js';
import type { Router } from '../router/router.js';
import { MODES, type Mode } from '../taxonomy.js';
import type { ChatRequest } from '../types.js';
import { Executor } from './execute.js';
import { readSse } from './sse.js';
import { explainWhy } from '../router/explain.js';

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
        preferences: z
          .object({
            quality_weight: z.number().min(0).max(100).optional(),
            cost_weight: z.number().min(0).max(100).optional(),
            speed_weight: z.number().min(0).max(100).optional(),
            open_weights: z.enum(['any', 'prefer', 'only']).optional(),
            prefer_providers: z.array(z.string()).optional(),
            avoid_providers: z.array(z.string()).optional(),
            min_quality: z.number().min(0).max(100).optional(),
          })
          .optional(),
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

  for (const path of ['/v1/*', '/ui/api/*']) {
    app.use(path, bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => openAiError(c, 413, 'Request body too large') }));
  }
  app.use('/ui/api/*', async (c, next) => {
    if (!config.gatewayKey) return next();
    const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!keyMatches(given, config.gatewayKey)) return openAiError(c, 401, 'Invalid or missing API key', 'authentication_error');
    return next();
  });
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
    const pr = r?.preferences;
    const prefs = {
      mode: auto.mode ?? r?.mode,
      preferences: pr && {
        qualityWeight: pr.quality_weight,
        costWeight: pr.cost_weight,
        speedWeight: pr.speed_weight,
        openWeights: pr.open_weights,
        preferProviders: pr.prefer_providers,
        avoidProviders: pr.avoid_providers,
        minQuality: pr.min_quality,
      },
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

  // --- Testing interface -------------------------------------------------------------------------
  app.get('/', (c) => c.html(readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8')));

  app.get('/ui/api/models', (c) =>
    c.json(
      store.listModels().map((m) => ({
        id: m.id,
        provider: m.provider,
        openWeights: m.openWeights,
        inputPrice: m.pricing.inputPerTok * 1e6,
        outputPrice: m.pricing.outputPerTok * 1e6,
        efforts: m.efforts,
        profile: m.profile,
      })),
    ),
  );

  const uiChatSchema = z.object({
    messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })).min(1),
    mode: z.enum(MODES).optional(),
    preferences: z
      .object({
        qualityWeight: z.number().min(0).max(100).optional(),
        costWeight: z.number().min(0).max(100).optional(),
        speedWeight: z.number().min(0).max(100).optional(),
        openWeights: z.enum(['any', 'prefer', 'only']).optional(),
        preferProviders: z.array(z.string()).optional(),
        avoidProviders: z.array(z.string()).optional(),
        minQuality: z.number().min(0).max(100).optional(),
      })
      .optional(),
    web: z.enum(['auto', 'on', 'off']).optional(),
    escalation: z.enum(['auto', 'off']).optional(),
    sessionId: z.string().max(200).optional(),
    dryRun: z.boolean().optional(),
  });

  // Routes the conversation, then streams: `decision` (full routing detail + plain-English reasons),
  // `delta` (answer text), `thinking` (reasoning started), `done` (actual usage) or `error`.
  app.post('/ui/api/chat', async (c) => {
    const parsed = uiChatSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return openAiError(c, 400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const b = parsed.data;
    const req: ChatRequest = { messages: b.messages, stream: true };
    return streamSSE(c, async (sse) => {
      const send = (event: string, data: unknown) => sse.writeSSE({ event, data: JSON.stringify(data) });
      let decision;
      try {
        decision = await router.route(req, {
          mode: b.mode,
          preferences: b.preferences,
          web: b.web,
          escalation: b.escalation,
          sessionId: b.sessionId,
        });
      } catch (err) {
        await send('error', { message: (err as Error).message });
        return;
      }
      await send('decision', { decision, why: explainWhy(decision) });
      if (b.dryRun) return;

      const started = performance.now();
      try {
        const result = await executor.execute(req, decision, c.req.raw.signal);
        if (!result.response.ok || !result.response.body) {
          const text = await result.response.text();
          let message = text.slice(0, 500);
          try {
            message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
          } catch {}
          await send('error', { status: result.response.status, message, attempts: result.attempts });
          return;
        }
        let ttftMs: number | undefined;
        let usage: Record<string, unknown> | undefined;
        let thinking = false;
        for await (const ev of readSse(result.response.body)) {
          const e = ev as { choices?: { delta?: { content?: string; reasoning?: string } }[]; usage?: Record<string, unknown>; error?: { message?: string } };
          if (e.error) await send('error', { message: e.error.message ?? 'upstream error' });
          const delta = e.choices?.[0]?.delta;
          if (delta?.reasoning && !thinking) {
            thinking = true;
            await send('thinking', {});
          }
          if (delta?.content) {
            ttftMs ??= performance.now() - started;
            await send('delta', { text: delta.content });
          }
          if (e.usage) usage = e.usage;
        }
        await send('done', {
          model: result.servedModel,
          effort: result.servedEffort,
          fallbacks: result.attempts.length - 1,
          latencyMs: performance.now() - started,
          ttftMs,
          usage,
        });
      } catch (err) {
        await send('error', { message: (err as Error).message });
      }
    });
  });

  app.onError((err, c) => {
    if (err instanceof ConfigError) return openAiError(c, 500, err.message, 'configuration_error');
    console.error(err);
    return openAiError(c, 500, err.message, 'server_error');
  });

  return app;
}
