import type { Store } from '../db/store.js';
import { estimateLatencySeconds, estimateTokens, ROUTER_OVERHEAD_TOKENS, webOverheadUsd } from '../router/estimate.js';
import { resolvePrefs, webDecision } from '../router/router.js';
import type { Effort } from '../taxonomy.js';
import type { ModelRecord, RequestFacts, TaskProfile } from '../types.js';

// Smoothing so near-zero counts (e.g. a model that barely thought) do not produce extreme ratios.
const SMOOTHING_TOKENS = 50;
const MIN_RATIO = 0.1;
const MAX_RATIO = 10;
const clamp = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));

export interface ObservedAnswer {
  promptTokens: number;
  completionTokens: number; // includes thinking tokens (OpenAI convention)
  reasoningTokens?: number;
  cachedTokens?: number;
  latencyMs: number;
  useWeb: boolean;
  costUsd?: number;
}

// Compares one real answer with what the estimator predicted (before any learned correction) and records
// the ratios: visible answer length per model, thinking tokens per model x effort, and time per model
// given the actual token counts (so it captures speed, not length).
export function observeAnswer(
  store: Store,
  model: ModelRecord,
  effort: Effort,
  task: TaskProfile,
  facts: RequestFacts,
  actual: ObservedAnswer,
): void {
  const raw = estimateTokens(task, effort, facts, model, { calibrated: false });
  const thinking = actual.reasoningTokens ?? 0;
  const visible = Math.max(0, actual.completionTokens - thinking);
  if (raw.output > 0) {
    const r = clamp((visible + SMOOTHING_TOKENS) / (raw.output + SMOOTHING_TOKENS));
    store.addCalibration(model.id, 'output', '*', r);
    store.addCalibration(model.id, 'output', String(task.outputLength.value), r);
  }
  // Billed prompt tokens vs the router's own count (web requests excluded: results inflate the prompt).
  if (!actual.useWeb && facts.inputTokens > 0) {
    store.addCalibration(model.id, 'input', '*', clamp(actual.promptTokens / (facts.inputTokens + ROUTER_OVERHEAD_TOKENS)));
  }
  if (raw.reasoning > 0 && actual.reasoningTokens !== undefined) {
    const r = clamp((thinking + SMOOTHING_TOKENS) / (raw.reasoning + SMOOTHING_TOKENS));
    store.addCalibration(model.id, 'reasoning', effort, r);
    store.addCalibration(model.id, 'reasoning', '*', r);
  }
  const predicted = estimateLatencySeconds(
    model,
    { input: actual.promptTokens, output: visible, reasoning: thinking },
    effort,
    { useWeb: actual.useWeb, cachedTokens: actual.cachedTokens ?? 0, calibrated: false },
  );
  if (predicted > 0 && actual.latencyMs > 0) store.addCalibration(model.id, 'latency', '*', clamp(actual.latencyMs / 1000 / predicted));
  if (actual.useWeb && actual.costUsd !== undefined) {
    // What web search actually added in dollars (injected results and/or per-search fees): the bill minus
    // what the conversation itself and the answer cost, relative to the default assumption.
    const p = model.pricing;
    const base = (facts.inputTokens + ROUTER_OVERHEAD_TOKENS) * p.inputPerTok + visible * p.outputPerTok + thinking * p.reasoningPerTok;
    const expected = webOverheadUsd(model);
    const r = clamp((Math.max(0, actual.costUsd - base) + expected * 0.05) / (expected * 1.05));
    store.addCalibration(model.id, 'web', '*', r);
    store.addCalibration('*', 'web', '*', r);
  }
}

// Rebuilds all calibration from the recorded history (e.g. after changing the estimator).
export function rebuildCalibration(store: Store): { answers: number; models: number } {
  store.resetCalibration();
  const models = new Map(store.listModels({ includeDisabled: true }).map((m) => [m.id, m]));
  const rows = store.db
    .prepare(
      `SELECT o.model_id, o.effort, o.prompt_tokens, o.completion_tokens, o.reasoning_tokens, o.cached_tokens, o.latency_ms,
              o.cost_usd, d.task, d.facts, d.request_id, d.use_web
       FROM outcomes o JOIN decisions d ON d.request_id = o.request_id
       WHERE o.status = 'ok' AND o.completion_tokens IS NOT NULL AND o.latency_ms IS NOT NULL`,
    )
    .all() as Record<string, unknown>[];
  const seen = new Set<string>();
  let answers = 0;
  for (const r of rows) {
    const model = models.get(r.model_id as string);
    if (!model) continue;
    const task = JSON.parse(r.task as string) as TaskProfile;
    const facts = JSON.parse(r.facts as string) as RequestFacts;
    observeAnswer(store, model, r.effort as Effort, task, facts, {
      promptTokens: r.prompt_tokens as number,
      completionTokens: r.completion_tokens as number,
      reasoningTokens: (r.reasoning_tokens as number | null) ?? undefined,
      cachedTokens: (r.cached_tokens as number | null) ?? undefined,
      latencyMs: r.latency_ms as number,
      // Older requests did not store web use; the router's own rule reproduces it from Jev's answers.
      useWeb: r.use_web === null ? webDecision(task, facts, resolvePrefs({})).on : r.use_web === 1,
      costUsd: (r.cost_usd as number | null) ?? undefined,
    });
    seen.add(model.id);
    answers++;
  }
  return { answers, models: seen.size };
}
