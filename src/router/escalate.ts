import { z } from 'zod';
import { config } from '../config.js';
import { chatCompletion } from '../providers/openrouter.js';
import { EFFORTS, type Effort, type Mode } from '../taxonomy.js';
import type { Candidate, ModelRecord, TaskProfile } from '../types.js';

const SHORTLIST_SIZE = 5;

// What the escalation model may choose from, by mode. In Cheap mode it only sees options that score close
// to the optimizer's own pick and cost at most a few times as much, so it can settle a genuinely unclear
// case without trading up to a much pricier model for a few points of estimated success. Balanced and Best
// see the top options as before.
export const ESCALATION_WINDOW: Record<Mode, { scoreWithin: number; maxCostRatio: number }> = {
  cheap: { scoreWithin: 0.25, maxCostRatio: 3 },
  balanced: { scoreWithin: Infinity, maxCostRatio: Infinity },
  best: { scoreWithin: Infinity, maxCostRatio: Infinity },
};

// What each mode asks the escalation model to optimise for.
const MODE_GOAL: Record<Mode, string> = {
  cheap:
    'The user chose CHEAP mode: keep cost low. Prefer the cheapest candidate that is likely to answer well; choose a pricier one only if the cheaper ones would probably get this request wrong. Waiting time barely matters.',
  balanced: 'The user chose BALANCED mode: weigh answer quality first, then cost and speed.',
  best: 'The user chose BEST mode: answer quality comes first; cost matters little.',
};

// Best effort level per model, in rank order, limited to the mode's window around the optimizer's pick.
// On a retry, the answer the user just rejected (same model at the same or a lower effort) is left out.
export function escalationShortlist(ranked: Candidate[], mode: Mode, retry?: { modelId: string; effort: Effort }): Candidate[] {
  const window = ESCALATION_WINDOW[mode];
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of ranked) {
    if (seen.has(c.modelId)) continue;
    if (retry && c.modelId === retry.modelId && EFFORTS.indexOf(c.effort as never) <= EFFORTS.indexOf(retry.effort as never)) continue;
    const top = out[0];
    if (top) {
      if (c.utility < top.utility - Math.abs(top.utility) * window.scoreWithin) continue;
      if (c.estCostUsd > top.estCostUsd * window.maxCostRatio) continue;
    }
    seen.add(c.modelId);
    out.push(c);
    if (out.length === SHORTLIST_SIZE) break;
  }
  return out;
}

export function escalationReasons(task: TaskProfile, ranked: Candidate[], value: number): string[] {
  const reasons: string[] = [];
  if (task.taskType.confidence < config.minTaskConfidence) {
    reasons.push(`task type unclear (${task.taskType.value}, confidence ${task.taskType.confidence.toFixed(2)})`);
  }
  if (task.difficulty.confidence < config.minDifficultyConfidence) {
    reasons.push(`difficulty unclear (confidence ${task.difficulty.confidence.toFixed(2)})`);
  }
  const [first] = ranked;
  const rival = ranked.find((c) => c.modelId !== first?.modelId);
  if (first && rival && first.utility - rival.utility < config.tieMargin * value) {
    reasons.push(`near tie: ${first.modelId} vs ${rival.modelId}`);
  }
  return reasons;
}

const usd = (perTok: number) => `$${(perTok * 1e6).toFixed(2)}`;

// Step 3 profile written by the profile LLM, with exact price/speed appended; falls back to a
// template built from the database when no profile has been generated yet.
export function modelProfile(m: ModelRecord): string {
  const facts = `price ${usd(m.pricing.inputPerTok)} in / ${usd(m.pricing.outputPerTok)} out per 1M tokens; ~${Math.round(m.tps)} tokens/s; context ${Math.round(m.contextLength / 1000)}K; inputs ${m.inputModalities.join('+')}; efforts ${m.efforts.join('/')}.`;
  if (m.profile) return `${m.id}: ${m.profile} (${facts})`;
  const top = m.efforts[m.efforts.length - 1]!;
  const at = (d: string) => (m.variantSkills[top] as Record<string, { skill: number }> | undefined)?.[d]?.skill ?? (m.skills as Record<string, { skill: number }>)[d]?.skill;
  const dims = ['reasoning', 'coding_debug', 'math', 'agentic', 'long_context'].map((d) => `${d} ${at(d)?.toFixed(0) ?? '?'}`);
  return `${m.id}: skill at ${top} effort (0-100): ${dims.join(', ')}; ${facts}`;
}

const pickSchema = z.object({ candidate: z.number().int(), rationale: z.string() });

export interface EscalationPick {
  index: number;
  rationale: string;
}

// A stronger LLM makes the final pick, but only among candidates that already passed the hard
// filters and scored near the top, so it can never choose an unusable model.
export async function escalateWithLlm(
  request: string,
  task: TaskProfile,
  shortlist: Candidate[],
  models: Map<string, ModelRecord>,
  reasons: string[],
  llm: typeof chatCompletion = chatCompletion,
  mode: Mode = 'balanced',
): Promise<EscalationPick> {
  const lines = shortlist.map((c, i) => {
    const m = models.get(c.modelId)!;
    const tag = i === 0 ? ' | router pick for this mode' : '';
    return `[${i}] ${c.effort} effort | est. success ${(c.pSuccess * 100).toFixed(0)}% | est. cost $${c.estCostUsd.toFixed(4)} | est. ${c.estLatencyS.toFixed(1)}s${tag}\n    ${modelProfile(m)}`;
  });
  const top = (d: Record<string, number>) =>
    Object.entries(d)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, p]) => `${k} ${(p * 100).toFixed(0)}%`)
      .join(', ');
  const prompt = [
    'You are the escalation step of an LLM router. The fast classifier was unsure, so pick the best candidate for this request.',
    MODE_GOAL[mode],
    'Reply with JSON only.',
    '',
    `Why escalated: ${reasons.join('; ')}`,
    `Classifier guesses - task type: ${top(task.taskType.probabilities)}; difficulty (0-4): ${top(task.difficulty.probabilities)}`,
    '',
    'Request (may be truncated):',
    '"""',
    request.slice(0, 6000),
    '"""',
    '',
    'Candidates:',
    ...lines,
  ].join('\n');

  const res = await llm(
    {
      model: config.escalationModel,
      messages: [{ role: 'user', content: prompt }],
      reasoning: { effort: 'low' },
      max_tokens: 2000,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'pick',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              candidate: { type: 'integer', description: 'Index of the chosen candidate' },
              rationale: { type: 'string', description: 'One sentence' },
            },
            required: ['candidate', 'rationale'],
            additionalProperties: false,
          },
        },
      },
    },
    AbortSignal.timeout(10000),
  );
  if (!res.ok) throw new Error(`escalation model returned ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? '';
  const parsed = pickSchema.parse(JSON.parse(text.replace(/^```(json)?|```$/g, '').trim()));
  if (parsed.candidate < 0 || parsed.candidate >= shortlist.length) throw new Error('escalation picked an invalid index');
  return { index: parsed.candidate, rationale: parsed.rationale };
}

// Fallback when the escalation model is unavailable: among the near-top options, prefer quality, except in
// Cheap mode, where the optimizer's own pick stands.
export function conservativePick(shortlist: Candidate[], mode: Mode = 'balanced'): number {
  if (mode === 'cheap') return 0;
  let best = 0;
  shortlist.slice(0, 3).forEach((c, i) => {
    if (c.pSuccess > shortlist[best]!.pSuccess) best = i;
  });
  return best;
}
