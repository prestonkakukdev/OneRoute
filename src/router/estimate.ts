import { statKey, type SuccessStat } from '../db/store.js';
import {
  CAPABILITY_MEAN_EXPONENT,
  DIFFICULTY_THRESHOLDS,
  DIFFICULTY_VALUE,
  EFFORT_BENEFIT,
  MAX_REASONING_GAIN_POINTS,
  OUTPUT_TOKENS_BY_LEVEL,
  REASONING_TOKENS,
  SUCCESS_CURVE_WIDTH,
  TASK_CAPABILITY_MIX,
  type Capability,
  type Effort,
  type TaskType,
} from '../taxonomy.js';
import type { ModelRecord, RequestFacts, TaskProfile } from '../types.js';

// Above this input size the model's measured long-context skill starts to matter.
export const LONG_CONTEXT_TOKENS = 32_000;
const MIN_WEIGHT = 0.05;
const MIN_TYPE_PROBABILITY = 0.02;
const MIN_LEVEL_PROBABILITY = 0.02;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function expectedLevel(d: { probabilities: Record<number, number> }): number {
  let sum = 0;
  let total = 0;
  for (const [level, p] of Object.entries(d.probabilities)) {
    sum += Number(level) * p;
    total += p;
  }
  return total > 0 ? sum / total : 0;
}

// 0 = the task gains nothing from thinking, 1 = needs extensive deliberation.
export const depthFactor = (task: TaskProfile) => expectedLevel(task.reasoningDepth) / 3;

// What this request needs, as weights over capabilities: the task type's default mix, plus Jev's
// per-capability importance, plus facts that are certain (images attached, very long input, tools).
export function requirementWeights(type: TaskType, task: TaskProfile, facts?: RequestFacts): Partial<Record<Capability, number>> {
  const w: Partial<Record<Capability, number>> = { ...TASK_CAPABILITY_MIX[type] };
  for (const [cap, importance] of Object.entries(task.capabilities) as [Capability, number][]) {
    // Operating a GUI only matters when the job is to act (agentic); Jev tends to over-rate it for
    // requests that merely mention screenshots, browsers or research.
    const gate = cap === 'computer_use' ? 0.3 + 0.7 * (task.taskType.probabilities.agentic ?? 0) : 1;
    w[cap] = (w[cap] ?? 0) + importance * gate;
  }
  if (facts) {
    const atLeast = (cap: Capability, v: number) => (w[cap] = Math.max(w[cap] ?? 0, v));
    if (facts.hasImages) atLeast('vision', 0.8);
    if (facts.hasFiles) atLeast('document_understanding', 0.6);
    if (facts.toolsPresent) atLeast('agentic_tool_use', 0.4);
    if (facts.inputTokens > LONG_CONTEXT_TOKENS) atLeast('long_context', Math.min(1, 0.3 + facts.inputTokens / 250_000));
  }
  for (const [cap, v] of Object.entries(w) as [Capability, number][]) if (v < MIN_WEIGHT) delete w[cap];
  return w;
}

const topEffort = (model: ModelRecord): Effort => model.efforts[model.efforts.length - 1] ?? 'default';

// Benchmarks measure reasoning-heavy work. A task that needs little deliberation loses only part
// of the measured gap between an effort level and the model's top effort.
const depthAdjust = (depth: number) => 0.3 + 0.7 * depth;

// Skill (0-100) of one model at one effort level on one capability. Per-effort values come from the
// capability DB (measured, or filled from the measured effort curve); the formula is only the fallback
// for bootstrap priors that lack per-effort data.
export function variantSkill(model: ModelRecord, effort: Effort, cap: Capability, depth: number): number | undefined {
  const at = model.variantSkills[effort]?.[cap]?.skill;
  if (at !== undefined) {
    const top = model.variantSkills[topEffort(model)]?.[cap]?.skill ?? at;
    return top - (top - at) * depthAdjust(depth);
  }
  const base = model.skills[cap]?.skill;
  if (base === undefined) return undefined;
  const lost = Math.max(0, EFFORT_BENEFIT[topEffort(model)] - EFFORT_BENEFIT[effort]);
  return base - MAX_REASONING_GAIN_POINTS * 0.6 * model.effortGain * depth * lost;
}

// Weighted generalised mean with a negative exponent: close to the average when capabilities are
// similar, pulled toward the weakest one when an important capability is missing.
export function combineSkills(parts: { skill: number; weight: number }[]): number | undefined {
  const total = parts.reduce((a, p) => a + p.weight, 0);
  if (!total) return undefined;
  const p = CAPABILITY_MEAN_EXPONENT;
  const mean = parts.reduce((a, x) => a + x.weight * Math.max(x.skill, 1) ** p, 0) / total;
  return mean ** (1 / p);
}

export type RequirementsByType = Partial<Record<TaskType, [Capability, number][]>>;

// Requirement weights for every task type Jev considers plausible; depends only on the request, so it is
// computed once per request rather than once per model x effort.
export function requirementsByType(task: TaskProfile, facts?: RequestFacts): RequirementsByType {
  const out: RequirementsByType = {};
  for (const [type, p] of Object.entries(task.taskType.probabilities) as [TaskType, number][]) {
    if (p >= MIN_TYPE_PROBABILITY) out[type] = Object.entries(requirementWeights(type, task, facts)) as [Capability, number][];
  }
  return out;
}

// The model's effective skill for one task type: its capabilities weighted by what the request needs.
export function requestSkill(model: ModelRecord, effort: Effort, needs: [Capability, number][], depth: number): number {
  const parts: { skill: number; weight: number }[] = [];
  for (const [cap, weight] of needs) {
    const skill = variantSkill(model, effort, cap, depth);
    if (skill !== undefined) parts.push({ skill, weight });
  }
  return combineSkills(parts) ?? 0;
}

export const successAtLevel = (skill: number, level: number) =>
  sigmoid((skill - DIFFICULTY_THRESHOLDS[Math.min(level, DIFFICULTY_THRESHOLDS.length - 1)]!) / SUCCESS_CURVE_WIDTH);

// Beta(a, b) sample via two Gamma draws (Marsaglia-Tsang), for Thompson-sampling exploration.
function gammaSample(shape: number): number {
  if (shape < 1) return gammaSample(shape + 1) * Math.random() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      const u1 = Math.random() || 1e-12;
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
      v = 1 + c * x;
    } while (v <= 0);
    v = v ** 3;
    const u = Math.random();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
const betaSample = (a: number, b: number) => {
  const x = gammaSample(a);
  return x / (x + gammaSample(b));
};

export interface LearningOptions {
  stats: Map<string, SuccessStat>;
  priorStrength: number;
  exploration: 'off' | 'thompson';
}

// Blend the prior with observed feedback as if the prior were `priorStrength` observations.
function blend(prior: number, stat: SuccessStat | undefined, opts: LearningOptions): number {
  const a = prior * opts.priorStrength + (stat?.successes ?? 0);
  const b = (1 - prior) * opts.priorStrength + ((stat?.trials ?? 0) - (stat?.successes ?? 0));
  if (opts.exploration === 'thompson') return betaSample(Math.max(a, 1e-3), Math.max(b, 1e-3));
  return a / (a + b);
}

// P(success), averaged over Jev's full probability distributions for task type and difficulty,
// so an uncertain classification automatically spreads its bets instead of trusting one label.
// `valueWeighted` weights each difficulty level by what a success there is worth (DIFFICULTY_VALUE).
export function expectedSuccess(
  model: ModelRecord,
  effort: Effort,
  task: TaskProfile,
  learning: LearningOptions,
  needs: RequirementsByType,
): { p: number; valueWeighted: number } {
  const depth = depthFactor(task);
  let total = 0;
  let valued = 0;
  let weight = 0;
  for (const [type, typeNeeds] of Object.entries(needs) as [TaskType, [Capability, number][]][]) {
    const pType = task.taskType.probabilities[type];
    const skill = requestSkill(model, effort, typeNeeds, depth);
    for (const [level, pLevel] of Object.entries(task.difficulty.probabilities)) {
      if (pLevel < MIN_LEVEL_PROBABILITY) continue;
      const lvl = Number(level);
      const p = blend(successAtLevel(skill, lvl), learning.stats.get(statKey(model.id, type, lvl)), learning);
      total += pType * pLevel * p;
      valued += pType * pLevel * p * (DIFFICULTY_VALUE[lvl] ?? 1);
      weight += pType * pLevel;
    }
  }
  return weight > 0 ? { p: total / weight, valueWeighted: valued / weight } : { p: 0, valueWeighted: 0 };
}

// Relative amount of reasoning a task consumes, by expected difficulty (Hard = 1).
const DIFFICULTY_TOKEN_SCALE = [0.15, 0.35, 0.6, 1, 1.6];

// The measured reasoning tokens come from a ~1K-token speed-test prompt, treated as a Moderate
// task needing some deliberation; scale from there to this request.
const REF_DIFFICULTY_SCALE = 0.6;
const REF_DEPTH_SCALE = 0.3 + 0.7 * 0.5;

// Speed and thinking behaviour for one effort level: Artificial Analysis per-effort measurements
// (nearest measured effort if this one was not measured), with throughput taken from live OpenRouter
// stats when available because that is the speed our requests actually get.
export function metricsFor(model: ModelRecord, effort: Effort): { tps: number; ttftS: number; reasoningTokensRef?: number } {
  const ladder = model.efforts;
  const i = ladder.indexOf(effort);
  const measured =
    model.variantMetrics[effort]?.tps !== undefined
      ? model.variantMetrics[effort]
      : Object.entries(model.variantMetrics)
          .filter(([, m]) => m?.tps)
          .sort((a, b) => Math.abs(ladder.indexOf(a[0] as Effort) - i) - Math.abs(ladder.indexOf(b[0] as Effort) - i))[0]?.[1];
  // Live stats from a handful of requests are noisy: blend with the benchmark measurement until
  // there is enough traffic.
  const live = model.providerStats;
  const bench = measured?.tps ?? model.tps;
  const liveWeight = live ? Math.min(1, live.requests / LIVE_STATS_FULL_WEIGHT_REQUESTS) : 0;
  return {
    tps: live ? liveWeight * live.tps + (1 - liveWeight) * bench : bench,
    ttftS: measured?.ttftS ?? Math.min(live?.latencyS ?? model.ttftMs / 1000, 1),
    reasoningTokensRef: model.variantMetrics[effort]?.reasoningTokensRef,
  };
}

const LIVE_STATS_FULL_WEIGHT_REQUESTS = 2000;

// Search results that OpenRouter's web plugin adds to the prompt (measured: ~8K tokens).
export const WEB_CONTEXT_TOKENS = 8000;

export function estimateTokens(task: TaskProfile, effort: Effort, facts: RequestFacts, model?: ModelRecord) {
  let output = 0;
  for (const [level, p] of Object.entries(task.outputLength.probabilities)) {
    output += (OUTPUT_TOKENS_BY_LEVEL[Number(level)] ?? 0) * p;
  }
  if (facts.requestedMaxTokens) output = Math.min(output, facts.requestedMaxTokens);
  const d = expectedLevel(task.difficulty);
  const lo = Math.floor(d);
  const scale =
    (DIFFICULTY_TOKEN_SCALE[lo] ?? 1.6) +
    ((DIFFICULTY_TOKEN_SCALE[Math.min(lo + 1, 4)] ?? 1.6) - (DIFFICULTY_TOKEN_SCALE[lo] ?? 1.6)) * (d - lo);
  const depthScale = 0.3 + 0.7 * depthFactor(task);
  const measured = model ? metricsFor(model, effort).reasoningTokensRef : undefined;
  const canReason = !model || model.supportedParams.includes('reasoning') || model.supportedParams.includes('include_reasoning');
  const reasoning =
    effort === 'none' || !canReason
      ? 0
      : measured !== undefined && measured > 0
        ? measured * (scale / REF_DIFFICULTY_SCALE) * (depthScale / REF_DEPTH_SCALE)
        : REASONING_TOKENS[effort] * scale * depthScale;
  return { input: facts.inputTokens, output: Math.round(output), reasoning: Math.round(reasoning) };
}

export function estimateCost(
  model: ModelRecord,
  tokens: { input: number; output: number; reasoning: number },
  facts: RequestFacts,
  opts: { sticky: boolean; useWeb: boolean },
): number {
  const p = model.pricing;
  const tier = (p.longContext ?? [])
    .filter((t) => tokens.input >= t.minPromptTokens)
    .sort((a, b) => b.minPromptTokens - a.minPromptTokens)[0];
  const inputPrice = tier?.inputPerTok ?? p.inputPerTok;
  const outputPrice = tier?.outputPerTok ?? p.outputPerTok;
  const reasoningPrice = tier ? tier.outputPerTok : p.reasoningPerTok;
  const cacheRead = tier?.cacheReadPerTok ?? p.cacheReadPerTok;
  // Staying on the session's model lets the conversation prefix be read from the prompt cache.
  const cached = opts.sticky && cacheRead !== undefined ? Math.min(facts.prefixTokens, tokens.input) : 0;
  const webTokens = opts.useWeb ? WEB_CONTEXT_TOKENS : 0;
  return (
    cached * cacheRead! +
    (tokens.input - cached + webTokens) * inputPrice +
    tokens.output * outputPrice +
    tokens.reasoning * reasoningPrice +
    (opts.useWeb ? (p.webSearchPerCall ?? 0.02) : 0)
  );
}

// Prompt processing speed for very long inputs (provisional: ~10K tokens/s across current providers).
const PREFILL_TOKENS_PER_S = 10_000;
// A web search round-trip before the model starts answering.
const WEB_SEARCH_S = 3;

// Unreliable providers cost time in retries and fallbacks; each point of downtime adds ~2% latency.
export function estimateLatencySeconds(
  model: ModelRecord,
  tokens: { input: number; output: number; reasoning: number },
  effort: Effort,
  opts: { useWeb: boolean } = { useWeb: false },
): number {
  const m = metricsFor(model, effort);
  const base =
    m.ttftS +
    tokens.input / PREFILL_TOKENS_PER_S +
    (opts.useWeb ? WEB_SEARCH_S : 0) +
    (tokens.output + tokens.reasoning) / Math.max(m.tps, 1);
  return base * (1 + 2 * (1 - (model.providerStats?.uptime ?? 1)));
}
