import { z } from 'zod';
import { config } from '../config.js';
import {
  DIFFICULTY_LEVELS,
  JEV_CAPABILITY_QUESTIONS,
  OUTPUT_LENGTH_LEVELS,
  REASONING_DEPTH_LEVELS,
  TASK_TYPES,
  TASK_TYPE_KEYS,
  type Capability,
  type TaskType,
} from '../taxonomy.js';
import type { Distribution, TaskProfile } from '../types.js';

export const IMPORTANCE_LEVELS = [
  'Not needed for this request.',
  'Helpful, but a model without it could still do well.',
  'Important: the answer is noticeably worse without it.',
  'Critical: the request fails without it.',
] as const;

// One importance question per capability; Jev answers all of them in parallel with the rest.
const capabilityQuestions = Object.fromEntries(
  Object.entries(JEV_CAPABILITY_QUESTIONS).map(([cap, what]) => [
    `need_${cap}`,
    {
      type: 'score',
      instructions: `How important is ${what} for handling \`latest_user_message\` well?`,
      criteria: IMPORTANCE_LEVELS,
    },
  ]),
);

// Atomic questions, answered in parallel by Jev in a single call. Each maps onto a database
// column or an optimizer input; model choice itself stays in code.
const CORE_QUESTIONS = {
  task_type: {
    type: 'choice',
    instructions:
      'What kind of task is the user asking for in `latest_user_message`? Use earlier messages only as context.',
    criteria: TASK_TYPES,
  },
  difficulty: {
    type: 'score',
    instructions:
      'How difficult is it to fully and correctly complete the request in `latest_user_message`, given the conversation so far?',
    criteria: DIFFICULTY_LEVELS,
  },
  reasoning_depth: {
    type: 'score',
    instructions: 'How much deliberate thinking would a strong expert need before answering `latest_user_message` well?',
    criteria: REASONING_DEPTH_LEVELS,
  },
  output_length: {
    type: 'score',
    instructions: 'How long does a complete answer to `latest_user_message` need to be?',
    criteria: OUTPUT_LENGTH_LEVELS,
  },
  needs_web: {
    type: 'noul',
    instructions:
      'Does answering `latest_user_message` well require information that may be newer than a model\'s training data, such as recent events, current prices, or newly released software or docs? This includes follow-up questions about recent news or releases discussed earlier in the conversation.',
    criteria: {
      true: 'Needs current or external information from the internet.',
      false: 'Can be answered from general knowledge and the content provided.',
    },
  },
  latency_sensitive: {
    type: 'noul',
    instructions:
      'Is the user likely waiting for a quick reply (casual chat, a quick lookup, a small edit) where speed matters more than depth?',
  },
  high_stakes: {
    type: 'noul',
    instructions:
      'Would a wrong or sloppy answer be costly, e.g. production code, legal, medical or financial decisions, or an important document?',
  },
  underspecified: {
    type: 'noul',
    instructions:
      'Is `latest_user_message` too vague to act on even with the earlier conversation, e.g. it refers to code, files or a problem that were never provided, so the right reply is a clarifying question?',
  },
} as const;

export const JEV_QUESTIONS = { ...CORE_QUESTIONS, ...capabilityQuestions };

const choiceAnswer = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});
const scoreAnswer = z.object({
  type: z.literal('score'),
  score: z.number(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});
const noulAnswer = z.object({ type: z.literal('noul'), noul: z.number() });

export const jevResponseSchema = z.object({
  model: z.string().optional(),
  answers: z
    .object({
      task_type: choiceAnswer,
      difficulty: scoreAnswer,
      reasoning_depth: scoreAnswer,
      output_length: scoreAnswer,
      needs_web: noulAnswer,
      latency_sensitive: noulAnswer,
      high_stakes: noulAnswer,
      underspecified: noulAnswer.optional(),
    })
    .catchall(z.union([choiceAnswer, scoreAnswer, noulAnswer])),
});
export type JevResponse = z.infer<typeof jevResponseSchema>;

function scoreDistribution(a: z.infer<typeof scoreAnswer>, levels: number): Distribution<number> {
  const probabilities: Record<number, number> = {};
  for (let i = 0; i < levels; i++) probabilities[i] = a.probabilities[String(i)] ?? 0;
  const best = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0];
  return { value: best ? Number(best[0]) : Math.round(a.score), probabilities, confidence: a.confidence };
}

// Expected importance on a 0-1 scale (critical = 1), from Jev's probabilities over the four levels.
function capabilityImportance(answers: JevResponse['answers']): Partial<Record<Capability, number>> {
  const out: Partial<Record<Capability, number>> = {};
  for (const cap of Object.keys(JEV_CAPABILITY_QUESTIONS) as Capability[]) {
    const a = answers[`need_${cap}`];
    if (a?.type !== 'score') continue;
    const top = IMPORTANCE_LEVELS.length - 1;
    let expected = 0;
    for (let i = 0; i <= top; i++) expected += i * (a.probabilities[String(i)] ?? 0);
    out[cap] = Math.round((expected / top) * 1000) / 1000;
  }
  return out;
}

export function toTaskProfile(res: JevResponse, latencyMs: number): TaskProfile {
  const a = res.answers;
  const probabilities = Object.fromEntries(TASK_TYPE_KEYS.map((k) => [k, a.task_type.probabilities[k] ?? 0])) as Record<
    TaskType,
    number
  >;
  const choice = (TASK_TYPE_KEYS as string[]).includes(a.task_type.choice) ? (a.task_type.choice as TaskType) : 'chat';
  return {
    taskType: { value: choice, probabilities, confidence: a.task_type.confidence },
    difficulty: scoreDistribution(a.difficulty, DIFFICULTY_LEVELS.length),
    reasoningDepth: scoreDistribution(a.reasoning_depth, REASONING_DEPTH_LEVELS.length),
    outputLength: scoreDistribution(a.output_length, OUTPUT_LENGTH_LEVELS.length),
    capabilities: capabilityImportance(a),
    needsWeb: a.needs_web.noul,
    latencySensitive: a.latency_sensitive.noul,
    highStakes: a.high_stakes.noul,
    underspecified: a.underspecified?.noul ?? 0,
    source: 'jev',
    latencyMs,
  };
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function classifyWithJev(state: unknown, fetchImpl: typeof fetch = fetch): Promise<TaskProfile> {
  if (!config.typesafeKey) throw new JevError('TYPESAFE_API_KEY is not set');
  const started = performance.now();
  const body = JSON.stringify({ model: config.jevModel, state, questions: JEV_QUESTIONS });
  const deadline = AbortSignal.timeout(config.jevTimeoutMs);

  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(`${config.typesafeBaseUrl}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.typesafeKey}`, 'Content-Type': 'application/json' },
      body,
      signal: deadline,
    });
    if (res.ok) {
      const parsed = jevResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new JevError(`Unexpected Jev response: ${parsed.error.message}`);
      return toTaskProfile(parsed.data, performance.now() - started);
    }
    // 429 rate limit / 529 overloaded: one quick retry inside the latency budget.
    if ((res.status === 429 || res.status === 529) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    throw new JevError(`Jev returned ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  }
}
