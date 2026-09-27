import { createHash, timingSafeEqual } from 'node:crypto';
import { conversationId } from '../cache.js';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { existsSync, readFileSync } from 'node:fs';
import { extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));
export const appBuilt = () => existsSync(`${WEB_DIST}index.html`);
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

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

// Distinguishes callers when deriving conversation ids, without keeping their keys.
const callerKey = (c: Context) => createHash('sha256').update(c.req.header('authorization') ?? '').digest('hex').slice(0, 16);

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
    const explicitSession = r?.session_id ?? c.req.header('x-router-session');
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
      sessionId: explicitSession ?? conversationId(body.messages, callerKey(c)),
      sessionExplicit: Boolean(explicitSession),
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

  // --- App (web/, built to web/dist) ----------------------------------------------------------------
  // Files are read on every request, so `npm run web:build` shows up on refresh without a restart.
  app.get('/', (c) => {
    const index = `${WEB_DIST}index.html`;
    if (!existsSync(index)) return c.html(`<p style="font:14px system-ui;padding:24px">The app is not built yet. Run <code>npm run web:build</code>, then reload.</p>`, 503);
    c.header('cache-control', 'no-cache');
    return c.html(readFileSync(index, 'utf8'));
  });
  app.get('/:file{(assets|icons)/.+|manifest\\.webmanifest|favicon\\.ico}', (c) => {
    const rel = normalize(c.req.param('file'));
    const path = `${WEB_DIST}${rel}`;
    if (rel.startsWith('..') || rel.includes(`..${sep}`) || !existsSync(path)) return c.notFound();
    // Built assets have content hashes in their names, so they never change.
    c.header('cache-control', rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    c.header('content-type', MIME[extname(path)] ?? 'application/octet-stream');
    return c.body(readFileSync(path));
  });

  // Saved chats. Turns are stored as the app sends them (including attachments, so a reopened chat can
  // continue with the same files).
  // Titles come from the first message, which can be any length; the store shortens them.
  const chatTurnSchema = z.object({ title: z.string(), turn: z.object({ id: z.string().min(1) }).loose() });
  app.get('/ui/api/chats', (c) => c.json(store.listChats()));
  app.get('/ui/api/chats/:id', (c) => {
    const chat = store.getChat(c.req.param('id'));
    return chat ? c.json(chat) : openAiError(c, 404, 'Chat not found');
  });
  app.put('/ui/api/chats/:id/turns/:turnId', async (c) => {
    const parsed = chatTurnSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return openAiError(c, 400, `Invalid chat turn: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
    if (parsed.data.turn.id !== c.req.param('turnId')) return openAiError(c, 400, 'The turn id in the body does not match the URL');
    store.saveChatTurn(c.req.param('id'), c.req.param('turnId'), parsed.data.turn, parsed.data.title);
    return c.json({ ok: true });
  });
  app.patch('/ui/api/chats/:id', async (c) => {
    const parsed = z.object({ title: z.string().min(1).max(120) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return openAiError(c, 400, 'Expected { title }');
    return store.renameChat(c.req.param('id'), parsed.data.title) ? c.json({ ok: true }) : openAiError(c, 404, 'Chat not found');
  });
  app.delete('/ui/api/chats/:id', (c) => (store.deleteChat(c.req.param('id')) ? c.json({ ok: true }) : openAiError(c, 404, 'Chat not found')));

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

  // The lab renders Markdown and LaTeX; saying so keeps formatting consistent whichever model answers.
  const FORMAT_NOTE =
    'Your reply is shown in a chat interface that renders Markdown (headings, lists, tables, code blocks) and LaTeX math between $...$ or $$...$$. Use that structure where it helps readability; keep short answers short.';
  const withFormatNote = <T extends { role: string }>(messages: T[]) =>
    messages.some((m) => m.role === 'system') ? messages : [{ role: 'system', content: FORMAT_NOTE } as unknown as T, ...messages];
  // Text, images (data URLs) and files (PDFs as data URLs); text files are sent inline as text parts.
  const uiPart = z.union([
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string() }) }),
    z.object({ type: z.literal('file'), file: z.object({ filename: z.string(), file_data: z.string() }) }),
  ]);
  const uiChatSchema = z.object({
    messages: z
      .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.union([z.string(), z.array(uiPart).min(1)]) }))
      .min(1),
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
    const req: ChatRequest = { messages: withFormatNote(b.messages), stream: true };
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
        const sources = new Map<string, string>(); // url -> title, from web-search citations
        for await (const ev of readSse(result.response.body)) {
          const e = ev as {
            choices?: { delta?: { content?: string; reasoning?: string; annotations?: { type?: string; url_citation?: { url?: string; title?: string } }[] } }[];
            usage?: Record<string, unknown>;
            error?: { message?: string };
          };
          for (const a of e.choices?.[0]?.delta?.annotations ?? []) {
            if (a.type === 'url_citation' && a.url_citation?.url) sources.set(a.url_citation.url, a.url_citation.title ?? a.url_citation.url);
          }
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
          sources: [...sources].map(([url, title]) => ({ url, title })),
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
