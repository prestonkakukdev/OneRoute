import { TASK_TYPE_KEYS, type Capability, type TaskType } from '../src/taxonomy.js';
import type { Distribution, RequestFacts, TaskProfile } from '../src/types.js';

// Remaining probability goes to the neighbouring levels, like a real ordinal judgment.
function levels(n: number, value: number, topP: number): Distribution<number> {
  const probabilities: Record<number, number> = {};
  for (let i = 0; i < n; i++) probabilities[i] = 0;
  const neighbours = [value - 1, value + 1].filter((i) => i >= 0 && i < n);
  probabilities[value] = topP;
  for (const i of neighbours) probabilities[i] = (1 - topP) / neighbours.length;
  return { value, probabilities, confidence: topP };
}

export function makeTask(opts: {
  type: TaskType;
  difficulty: number;
  depth?: number;
  output?: number;
  typeP?: number;
  diffP?: number;
  needsWeb?: number;
  latencySensitive?: number;
  highStakes?: number;
  capabilities?: Partial<Record<Capability, number>>;
}): TaskProfile {
  const typeP = opts.typeP ?? 0.9;
  const probabilities = Object.fromEntries(
    TASK_TYPE_KEYS.map((k) => [k, k === opts.type ? typeP : (1 - typeP) / (TASK_TYPE_KEYS.length - 1)]),
  ) as Record<TaskType, number>;
  return {
    taskType: { value: opts.type, probabilities, confidence: typeP },
    difficulty: levels(5, opts.difficulty, opts.diffP ?? 0.8),
    reasoningDepth: levels(4, opts.depth ?? Math.min(opts.difficulty, 3), 0.8),
    outputLength: levels(4, opts.output ?? 1, 0.8),
    capabilities: opts.capabilities ?? {},
    needsWeb: opts.needsWeb ?? 0.05,
    latencySensitive: opts.latencySensitive ?? 0.2,
    highStakes: opts.highStakes ?? 0.2,
    source: 'jev',
    latencyMs: 100,
  };
}

export const facts = (over: Partial<RequestFacts> = {}): RequestFacts => ({
  inputTokens: 500,
  prefixTokens: 0,
  hasImages: false,
  hasFiles: false,
  hasAudio: false,
  toolsPresent: false,
  jsonSchemaRequired: false,
  ...over,
});
