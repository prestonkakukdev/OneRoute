import { TASK_TYPE_KEYS, type TaskType } from '../taxonomy.js';
import type { Distribution, RequestFacts, TaskProfile } from '../types.js';

// Keyword fallback used only when Jev is unavailable. Deliberately low-confidence so the
// optimizer spreads its bets and escalation can kick in.
const RULES: [TaskType, RegExp][] = [
  ['coding_debug', /\b(bug|error|exception|throws?|stack ?trace|traceback|fails?|failing|broken|crash|fix|debug|not working|undefined is not|segfault)\b/i],
  ['coding_refactor', /\b(refactor|migrat\w*|rewrite the|restructure|across the (repo|codebase)|monorepo|architecture)\b/i],
  ['coding_generate', /\b(write|implement|create|build|add)\b.*\b(function|class|script|component|api|endpoint|program|code|test)s?\b|```/i],
  ['coding_explain', /\b(explain|what does|review)\b.*\b(code|function|snippet|regex|query)\b/i],
  ['math', /\b(prove|integral|derivative|equation|solve for|probability|theorem|matrix|calculate)\b|\d+\s*[-+*/^]\s*\d+/i],
  ['research', /\b(latest|today|news|current(ly)?|this (week|month|year)|price of|release[sd]?)\b/i],
  ['agentic', /\b(browse|navigate to|click|fill (in|out)|book|automate|go to the website)\b/i],
  ['extraction', /\b(summari[sz]e|extract|classify|translate|convert .* to|tl;?dr|bullet points)\b/i],
  ['writing', /\b(write|draft|rewrite|edit|essay|email|story|poem|blog|cover letter)\b/i],
  ['reasoning', /\b(should i|trade-?offs?|compare|pros and cons|plan|strategy|why)\b/i],
];

function spread<K extends string | number>(keys: readonly K[], top: K, topP: number): Record<K, number> {
  const rest = (1 - topP) / Math.max(keys.length - 1, 1);
  return Object.fromEntries(keys.map((k) => [k, k === top ? topP : rest])) as Record<K, number>;
}

// Ordinal guess: the remaining probability goes to the neighbouring levels.
function dist(levels: number, value: number, topP: number): Distribution<number> {
  const probabilities: Record<number, number> = {};
  const neighbours = [value - 1, value + 1].filter((i) => i >= 0 && i < levels);
  for (let i = 0; i < levels; i++) probabilities[i] = 0;
  probabilities[value] = topP;
  for (const i of neighbours) probabilities[i] = (1 - topP) / neighbours.length;
  return { value, probabilities, confidence: topP / 2 };
}

export function classifyHeuristically(text: string, facts: RequestFacts, error?: string): TaskProfile {
  const started = performance.now();
  const match = RULES.find(([, re]) => re.test(text));
  const taskType: TaskType = match ? match[0] : text.length < 80 ? 'chat' : 'reasoning';
  const topP = match ? 0.5 : 0.3;
  const long = facts.inputTokens > 4000;
  const difficulty = long || taskType === 'coding_refactor' ? 3 : text.length < 30 ? 0 : text.length < 200 ? 1 : 2;
  return {
    taskType: { value: taskType, probabilities: spread(TASK_TYPE_KEYS, taskType, topP), confidence: topP / 2 },
    difficulty: dist(5, difficulty, 0.4),
    reasoningDepth: dist(4, Math.min(difficulty, 3), 0.4),
    outputLength: dist(4, taskType === 'chat' ? 0 : taskType.startsWith('coding') ? 2 : 1, 0.4),
    capabilities: {},
    needsWeb: taskType === 'research' ? 0.7 : 0.1,
    latencySensitive: taskType === 'chat' ? 0.7 : 0.3,
    highStakes: 0.3,
    source: 'heuristic',
    latencyMs: performance.now() - started,
    error,
  };
}
