// Per-step limits for agent runs, the way coding agents bound what one model turn can cost.
//
// The router picks an effort as if the whole task were one answer. In an agent loop the work is spread over many
// small steps (read, write a file, run the tests, fix), and no single step needs the deepest reasoning; at the
// highest efforts a model can spend its entire output allowance planning before it acts. Three limits:
//   - an output cap on every step (hard; the provider stops there),
//   - a thinking allowance: a step that thinks this long without writing or acting is stopped by OneRoute
//     (models may ignore a thinking budget sent to the provider, e.g. Claude Sonnet 5.5 at 4x its budget),
//   - an effort cap per mode, for models whose runaway step would be expensive; cheap models keep the effort
//     the router chose (DeepSeek V4.1 Flash at max builds well for cents).

import type { Effort, Mode } from '../taxonomy.js';
import type { RouteDecision } from '../types.js';

// The highest effort an agent step uses in each mode (Claude Code and Codex default to medium).
export const STEP_EFFORT_CAP: Record<Mode, Effort> = { cheap: 'medium', balanced: 'high', best: 'xhigh' };

// Output tokens per step, thinking included. Big enough for a long file in one tool call, small enough that a
// turn spent only thinking costs a fraction of the model's maximum.
export const STEP_MAX_TOKENS: Record<Mode, number> = { cheap: 16_000, balanced: 32_000, best: 48_000 };

// Thinking tokens a step may use before it has written anything or started a tool call.
export const STEP_THINK_TOKENS: Record<Mode, number> = { cheap: 8_000, balanced: 16_000, best: 24_000 };

// The effort cap applies only when a step running to its output cap would cost more than this.
export const EXPENSIVE_STEP_USD = 0.05;

const ORDER: Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// The highest effort the model offers that is no higher than `cap` (unchanged if the model has no effort levels).
export function capEffort(effort: Effort, offered: Effort[], cap: Effort): Effort {
  const i = ORDER.indexOf(effort);
  const c = ORDER.indexOf(cap);
  if (i < 0 || c < 0 || i <= c) return effort;
  for (let j = c; j >= 0; j--) if (offered.includes(ORDER[j]!)) return ORDER[j]!;
  return effort;
}

// The next effort below `effort` that the model offers, for a retry after a turn was cut off while thinking.
export function lowerEffort(effort: Effort, offered: Effort[]): Effort | undefined {
  const i = ORDER.indexOf(effort);
  for (let j = i - 1; j > 0; j--) if (offered.includes(ORDER[j]!)) return ORDER[j];
  return undefined;
}

export function stepMaxTokens(mode: Mode, modelMaxOutput?: number): number {
  return Math.min(STEP_MAX_TOKENS[mode], modelMaxOutput && modelMaxOutput > 0 ? modelMaxOutput : Infinity);
}

export function capDecision(d: RouteDecision, offered: Effort[], mode: Mode, outputPerTok = 0, modelMaxOutput?: number): RouteDecision {
  if (outputPerTok * stepMaxTokens(mode, modelMaxOutput) <= EXPENSIVE_STEP_USD) return d;
  const effort = capEffort(d.effort, offered, STEP_EFFORT_CAP[mode]);
  return effort === d.effort ? d : { ...d, effort };
}
