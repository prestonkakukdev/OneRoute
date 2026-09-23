import { z } from 'zod';
import { config } from '../config.js';
import { chatCompletion } from '../providers/openrouter.js';
import type { Candidate, ModelRecord, TaskProfile } from '../types.js';

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
): Promise<EscalationPick> {
  const lines = shortlist.map((c, i) => {
    const m = models.get(c.modelId)!;
    return `[${i}] ${c.effort} effort | est. success ${(c.pSuccess * 100).toFixed(0)}% | est. cost $${c.estCostUsd.toFixed(4)} | est. ${c.estLatencyS.toFixed(1)}s\n    ${modelProfile(m)}`;
  });
  const top = (d: Record<string, number>) =>
    Object.entries(d)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, p]) => `${k} ${(p * 100).toFixed(0)}%`)
      .join(', ');
  const prompt = [
    'You are the escalation step of an LLM router. The fast classifier was unsure, so pick the best candidate for this request.',
    'Weigh answer quality first, then cost and speed. Reply with JSON only.',
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

// Fallback when the escalation model is unavailable: among the near-top options, prefer quality.
export function conservativePick(shortlist: Candidate[]): number {
  let best = 0;
  shortlist.slice(0, 3).forEach((c, i) => {
    if (c.pSuccess > shortlist[best]!.pSuccess) best = i;
  });
  return best;
}
