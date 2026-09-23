import { DIFFICULTY_VALUE, MODE_WEIGHTS, QUALITY_FLOOR_RATIO } from '../taxonomy.js';
import type { Candidate, ModelRecord, RequestFacts, RoutePrefs, TaskProfile } from '../types.js';
import {
  estimateCost,
  estimateLatencySeconds,
  estimateTokens,
  expectedSuccess,
  requirementsByType,
  type LearningOptions,
} from './estimate.js';

export class RoutingError extends Error {}

const MIN_OUTPUT_ROOM = 1000;

// Hard requirements first: a model that cannot do the job is never scored.
export function rejectionReason(model: ModelRecord, facts: RequestFacts, prefs: RoutePrefs): string | null {
  if (prefs.allowModels?.length && !prefs.allowModels.includes(model.id)) return 'not in allow list';
  if (prefs.denyModels?.includes(model.id)) return 'in deny list';
  if (facts.inputTokens + MIN_OUTPUT_ROOM > model.contextLength) return 'context window too small';
  if (facts.hasImages && !model.inputModalities.includes('image')) return 'no image input';
  if (facts.hasFiles && !model.inputModalities.includes('file')) return 'no file input';
  if (facts.hasAudio && !model.inputModalities.includes('audio')) return 'no audio input';
  if (facts.toolsPresent && !model.supportedParams.includes('tools')) return 'no tool calling';
  if (facts.jsonSchemaRequired && !model.supportedParams.includes('structured_outputs')) return 'no structured outputs';
  return null;
}

// USD value of a Moderate-difficulty success for this request; high stakes raise it.
const baseValue = (task: TaskProfile, prefs: RoutePrefs) => MODE_WEIGHTS[prefs.mode].valueUsd * (1 + 2 * task.highStakes);

// Expected USD value of a success for this request, across Jev's difficulty distribution.
export function successValue(task: TaskProfile, prefs: RoutePrefs): number {
  let mult = 0;
  for (const [level, p] of Object.entries(task.difficulty.probabilities)) mult += p * (DIFFICULTY_VALUE[Number(level)] ?? 1);
  return baseValue(task, prefs) * mult;
}

export interface RankInput {
  models: ModelRecord[];
  task: TaskProfile;
  facts: RequestFacts;
  prefs: RoutePrefs;
  learning: LearningOptions;
  stickyModelId?: string;
  useWeb: boolean;
}

// score = P(success) x value - expected cost - expected latency x value of time
// (value varies by difficulty level, so P(success) is value-weighted across Jev's difficulty distribution)
export function rankCandidates(input: RankInput): { ranked: Candidate[]; rejected: Record<string, string> } {
  const { task, facts, prefs } = input;
  const value = baseValue(task, prefs);
  const latencyPrice = MODE_WEIGHTS[prefs.mode].latencyUsdPerSec * (1 + 9 * task.latencySensitive);
  const rejected: Record<string, string> = {};
  const ranked: Candidate[] = [];
  const needs = requirementsByType(task, facts);

  for (const model of input.models) {
    const reason = rejectionReason(model, facts, prefs);
    if (reason) {
      rejected[model.id] = reason;
      continue;
    }
    for (const effort of model.efforts) {
      const tokens = estimateTokens(task, effort, facts, model);
      const estCostUsd = estimateCost(model, tokens, facts, {
        sticky: model.id === input.stickyModelId,
        useWeb: input.useWeb,
      });
      const estLatencyS = estimateLatencySeconds(model, tokens, effort, { useWeb: input.useWeb });
      if (prefs.maxCostUsd !== undefined && estCostUsd > prefs.maxCostUsd) continue;
      if (prefs.maxLatencyS !== undefined && estLatencyS > prefs.maxLatencyS) continue;
      const success = expectedSuccess(model, effort, task, input.learning, needs);
      ranked.push({
        modelId: model.id,
        effort,
        pSuccess: success.p,
        estCostUsd,
        estLatencyS,
        utility: success.valueWeighted * value - estCostUsd - estLatencyS * latencyPrice,
      });
    }
  }

  const floor = QUALITY_FLOOR_RATIO * Math.max(0, ...ranked.map((c) => c.pSuccess));
  ranked.sort((a, b) => Number(a.pSuccess < floor) - Number(b.pSuccess < floor) || b.utility - a.utility);
  if (!ranked.length) {
    const why = Object.keys(rejected).length ? ` Rejections: ${JSON.stringify(rejected)}` : '';
    throw new RoutingError(`No model satisfies this request's requirements and limits.${why}`);
  }
  return { ranked, rejected };
}
