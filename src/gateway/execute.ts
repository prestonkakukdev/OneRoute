import type { Store } from '../db/store.js';
import { observeAnswer } from '../learning/calibration.js';
import { chatCompletion, ConfigError } from '../providers/openrouter.js';
import { config } from '../config.js';
import type { Effort } from '../taxonomy.js';
import { estimateTokens } from '../classifier/state.js';
import { CACHE_MIN_TOKENS, cachePlan } from '../cache.js';
import type { ChatMessage, ChatRequest, ModelRecord, RequestFacts, RouteDecision } from '../types.js';
import { SseLineParser } from './sse.js';

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

export interface Attempt {
  modelId: string;
  effort: Effort;
  status: number | 'network_error';
  error?: string;
}

export interface ExecutionResult {
  response: Response;
  servedModel: string;
  servedEffort: Effort;
  attempts: Attempt[];
}

// Auth / billing failures are account-wide; trying another model would fail the same way.
const NO_FALLBACK = new Set([401, 402, 403]);

export function reasoningParam(effort: Effort): Record<string, unknown> | undefined {
  if (effort === 'default') return undefined;
  if (effort === 'none') return { enabled: false };
  return { effort };
}

// Added to every routed request. Different turns can be answered by different models with different tools,
// so a model must not read a predecessor's web-sourced facts as fabrications. Stating today's date matters:
// without it, models assume their training cutoff is "now" and reject newer events. The text changes only
// once a day and once when a conversation first uses web search, so prompt caching keeps working.
export function continuityNote(opts: { date?: string; recentWeb?: boolean } = {}): string {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  return (
    `Note: today's date is ${date}. This conversation is served by several AI models. Earlier assistant replies may ` +
    'have been written by a different model, sometimes using live web search, so facts in them can be newer than your ' +
    'training data. ' +
    (opts.recentWeb ? 'Earlier replies in this conversation did use live web search results. ' : '') +
    'Do not treat such facts as errors or fabrications just because you cannot verify them, and do not apologize for or ' +
    'retract earlier replies unless the user questions them or they clearly contradict something in this conversation. ' +
    'If you cannot access information the user needs right now (for example, live web results), say so briefly and ' +
    'answer as well as you can.'
  );
}

function withContinuityNote(messages: ChatMessage[], note: string): ChatMessage[] {
  const firstNonSystem = messages.findIndex((m) => m.role !== 'system' && m.role !== 'developer');
  const at = firstNonSystem < 0 ? messages.length : firstNonSystem;
  return [...messages.slice(0, at), { role: 'system', content: note }, ...messages.slice(at)];
}

export function buildUpstreamBody(
  req: ChatRequest,
  modelId: string,
  effort: Effort,
  model: ModelRecord | undefined,
  decision: Pick<RouteDecision, 'useWeb' | 'facts'> & Partial<Pick<RouteDecision, 'sessionId' | 'sessionExplicit' | 'recentWeb'>>,
): Record<string, unknown> {
  const { router: _router, ...rest } = req;
  const note = continuityNote({ recentWeb: decision.recentWeb });
  const body: Record<string, unknown> = { ...rest, messages: withContinuityNote(req.messages, note), model: modelId, usage: { include: true } };
  const reasoning = reasoningParam(effort);
  if (reasoning) body.reasoning = reasoning;
  else delete body.reasoning;
  const plugins = Array.isArray(req.plugins) ? [...(req.plugins as unknown[])] : [];
  if (decision.useWeb) plugins.push({ id: 'web' });
  // Models without native PDF input get the text extracted for free (OpenRouter's default is paid OCR).
  const parsesPdf = plugins.some((p) => (p as { id?: string }).id === 'file-parser');
  if (decision.facts.hasFiles && !parsesPdf && model && !model.inputModalities.includes('file')) {
    plugins.push({ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } });
  }
  if (plugins.length) body.plugins = plugins;
  if (model?.provider === 'anthropic') addAnthropicCacheBreakpoints(body, decision.facts, cachePlan(decision.facts, Boolean(decision.sessionId) && decision.sessionExplicit !== false));
  return body;
}

// Anthropic caches only at explicit breakpoints (other providers cache prefixes automatically).
// Verified live: a breakpoint on a long system prompt is reused across different questions, the top-level
// breakpoint is reused as a conversation grows, and ttl "1h" is honoured (billed at the 1-hour write price).
function addAnthropicCacheBreakpoints(body: Record<string, unknown>, facts: RequestFacts, plan: { write: boolean; ttl: '5m' | '1h' }): void {
  if (!plan.write) return;
  const control = plan.ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  const messages = body.messages as ChatMessage[];
  const i = messages.findIndex((m) => m.role === 'system');
  const system = messages[i];
  // Same TTL on both breakpoints: Anthropic rejects a longer-lived breakpoint after a shorter one.
  if (system && typeof system.content === 'string' && estimateTokens(system.content) >= CACHE_MIN_TOKENS) {
    const copy = [...messages];
    copy[i] = { ...system, content: [{ type: 'text', text: system.content, cache_control: control }] };
    body.messages = copy;
  }
  if (!('cache_control' in body)) body.cache_control = control;
}

function fallbackChain(decision: RouteDecision): { modelId: string; effort: Effort }[] {
  const chain = [{ modelId: decision.modelId, effort: decision.effort }];
  for (const c of decision.candidates) {
    if (chain.length > config.maxFallbacks) break;
    if (!chain.some((x) => x.modelId === c.modelId)) chain.push({ modelId: c.modelId, effort: c.effort });
  }
  return chain;
}

function routerHeaders(decision: RouteDecision, modelId: string, effort: Effort): Record<string, string> {
  return {
    'x-router-request-id': decision.requestId,
    'x-router-model': modelId,
    'x-router-effort': effort,
    'x-router-task': decision.task.taskType.value,
  };
}

export function routerMetadata(decision: RouteDecision, modelId: string, effort: Effort, attempts: Attempt[]) {
  const chosen = decision.candidates[0];
  return {
    request_id: decision.requestId,
    model: modelId,
    effort,
    mode: decision.mode,
    task_type: decision.task.taskType.value,
    task_confidence: Number(decision.task.taskType.confidence.toFixed(3)),
    difficulty: decision.task.difficulty.value,
    classifier: decision.task.source,
    web_search: decision.useWeb,
    escalated: decision.escalation !== null,
    est_success: chosen ? Number(chosen.pSuccess.toFixed(3)) : undefined,
    est_cost_usd: chosen ? Number(chosen.estCostUsd.toFixed(6)) : undefined,
    fallbacks: attempts.length - 1,
    route_ms: Math.round(decision.routeMs),
  };
}

export class Executor {
  constructor(
    private readonly store: Store,
    private readonly llm: typeof chatCompletion = chatCompletion,
  ) {}

  async execute(req: ChatRequest, decision: RouteDecision, signal?: AbortSignal): Promise<ExecutionResult> {
    const models = new Map(this.store.listModels({ includeDisabled: true }).map((m) => [m.id, m]));
    const attempts: Attempt[] = [];
    let lastResponse: Response | undefined;

    for (const { modelId, effort } of fallbackChain(decision)) {
      const started = performance.now();
      let res: Response;
      try {
        res = await this.llm(buildUpstreamBody(req, modelId, effort, models.get(modelId), decision), signal);
      } catch (err) {
        if (signal?.aborted || err instanceof ConfigError) throw err;
        attempts.push({ modelId, effort, status: 'network_error', error: (err as Error).message });
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        attempts.push({ modelId, effort, status: res.status, error: text.slice(0, 500) });
        lastResponse = new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
        this.store.recordOutcome({ requestId: decision.requestId, modelId, effort, status: 'error', error: `${res.status}: ${text.slice(0, 300)}` });
        if (NO_FALLBACK.has(res.status)) break;
        continue;
      }
      attempts.push({ modelId, effort, status: res.status });
      const headers = routerHeaders(decision, modelId, effort);
      const finish = (usage: Usage | undefined, ttftMs: number | undefined, error?: string, provider?: string) =>
        this.finish(decision, modelId, effort, usage, ttftMs, performance.now() - started, models.get(modelId), attempts.length - 1, error, provider);

      if (req.stream && res.body) {
        return {
          response: new Response(res.body.pipeThrough(tap(finish, started)), {
            status: 200,
            headers: { 'content-type': res.headers.get('content-type') ?? 'text/event-stream', 'cache-control': 'no-cache', ...headers },
          }),
          servedModel: modelId,
          servedEffort: effort,
          attempts,
        };
      }
      const json = (await res.json()) as { usage?: Usage; provider?: string; [k: string]: unknown };
      finish(json.usage, undefined, undefined, json.provider);
      json.router = routerMetadata(decision, modelId, effort, attempts);
      return {
        response: new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json', ...headers } }),
        servedModel: modelId,
        servedEffort: effort,
        attempts,
      };
    }

    const summary = attempts.map((a) => `${a.modelId}: ${a.status}${a.error ? ` (${a.error.slice(0, 120)})` : ''}`).join('; ');
    return {
      response:
        lastResponse ??
        Response.json({ error: { message: `All models failed (${summary})`, type: 'upstream_error' } }, { status: 502 }),
      servedModel: decision.modelId,
      servedEffort: decision.effort,
      attempts,
    };
  }

  private finish(
    decision: RouteDecision,
    modelId: string,
    effort: Effort,
    usage: Usage | undefined,
    ttftMs: number | undefined,
    latencyMs: number,
    model: ModelRecord | undefined,
    fallbacks: number,
    error?: string,
    provider?: string,
  ): void {
    this.store.recordOutcome({
      requestId: decision.requestId,
      modelId,
      effort,
      status: error ? 'error' : 'ok',
      error,
      fallbacks,
      latencyMs,
      ttftMs,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
      costUsd: usage?.cost,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
      cacheWriteTokens: usage?.prompt_tokens_details?.cache_write_tokens,
      provider,
    });
    if (error) return;
    // Learn how this model's real answers differ from the estimate (length, thinking, time).
    if (model && usage?.completion_tokens !== undefined && usage.prompt_tokens !== undefined) {
      observeAnswer(this.store, model, effort, decision.task, decision.facts, {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens,
        latencyMs,
        useWeb: decision.useWeb,
        costUsd: usage.cost,
      });
    }
    // Learn real speed. Without a measured first-token time, assume the current estimate.
    const generationMs = latencyMs - (ttftMs ?? model?.ttftMs ?? 0);
    const tps = usage?.completion_tokens && generationMs > 200 ? usage.completion_tokens / (generationMs / 1000) : undefined;
    this.store.updatePerformance(modelId, ttftMs, tps);
    if (decision.sessionId) this.store.setSession(decision.sessionId, modelId, effort, decision.useWeb);
  }
}

// Passes the upstream SSE bytes through untouched while watching for first-token time and usage.
// A client that disconnects mid-stream is still recorded (as an interrupted request).
function tap(onDone: (usage: Usage | undefined, ttftMs: number | undefined, error?: string, provider?: string) => void, started: number) {
  const parser = new SseLineParser();
  let usage: Usage | undefined;
  let ttftMs: number | undefined;
  let provider: string | undefined;
  const inspect = (events: unknown[]) => {
    for (const e of events) {
      const ev = e as { usage?: Usage; provider?: string; choices?: { delta?: Record<string, unknown> }[] };
      if (ev.usage) usage = ev.usage;
      if (ev.provider) provider = ev.provider;
      const delta = ev.choices?.[0]?.delta;
      if (ttftMs === undefined && delta && (delta.content || delta.reasoning || delta.tool_calls)) {
        ttftMs = performance.now() - started;
      }
    }
  };
  // `cancel` is part of the Streams spec (supported by Node 22+) but missing from TypeScript's lib types.
  const transformer: Transformer<Uint8Array, Uint8Array> & { cancel(reason: unknown): void } = {
    transform(chunk, controller) {
      inspect(parser.push(chunk));
      controller.enqueue(chunk);
    },
    flush() {
      inspect(parser.flush());
      onDone(usage, ttftMs, undefined, provider);
    },
    cancel(reason) {
      onDone(usage, ttftMs, `stream cancelled: ${String(reason ?? 'client disconnected')}`, provider);
    },
  };
  return new TransformStream<Uint8Array, Uint8Array>(transformer);
}
