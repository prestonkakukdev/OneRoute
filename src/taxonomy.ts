// Shared vocabulary. Jev's questions, the capability database and the optimizer
// all use these exact keys, so a Jev answer maps 1:1 onto database columns.

export const TASK_TYPES = {
  coding_generate: 'Writing new code: a function, feature, script, component or small program.',
  coding_debug: 'Finding and fixing a bug, error message, failing test or unexpected behavior in code.',
  coding_refactor: 'Large or multi-file code changes: refactors, migrations, architecture or repo-wide edits.',
  coding_explain: 'Explaining, reviewing or answering a question about code or a programming concept, without writing much new code.',
  math: 'Mathematics or quantitative problems: calculations, proofs, statistics, word problems.',
  reasoning: 'Logic puzzles, analysis, planning, strategy or decisions that need careful multi-step thinking.',
  writing: 'Writing or editing prose: emails, essays, stories, marketing copy, rewriting text.',
  extraction: 'Summarizing, extracting, classifying, translating or reformatting given text or data.',
  research: 'Questions that need current or external facts: news, recent releases, prices, looking things up.',
  agentic: 'Autonomous multi-step work that uses tools, browses, operates software or runs a workflow.',
  chat: 'Casual conversation, greetings or a simple factual question with a short answer.',
} as const;

export type TaskType = keyof typeof TASK_TYPES;
export const TASK_TYPE_KEYS = Object.keys(TASK_TYPES) as TaskType[];

// Score levels are concrete situations (TypeSafe guidance), low -> high.
export const DIFFICULTY_LEVELS = [
  'Trivial: a greeting, a well-known fact, or a one-line answer anyone could give.',
  'Easy: a routine task a competent junior could do quickly, e.g. a simple function or a short email.',
  'Moderate: needs care and real expertise, e.g. multi-part code, a non-trivial analysis, a detailed document.',
  'Hard: expert-level and easy to get subtly wrong, e.g. a tricky bug, a complex algorithm, a proof, a subtle trade-off.',
  'Frontier: very hard even for top experts, e.g. large system design, research-level math, a long autonomous project.',
] as const;

export const REASONING_DEPTH_LEVELS = [
  'Answer immediately; no deliberation needed.',
  'A little thinking helps, e.g. checking one or two details.',
  'Careful step-by-step reasoning is needed to get it right.',
  'Extensive deliberation: exploring alternatives, planning, and verifying the result.',
] as const;

export const OUTPUT_LENGTH_LEVELS = [
  'A sentence or two.',
  'A few paragraphs or a short code snippet.',
  'A full document or one complete file of code.',
  'Very long output: several files or a long report.',
] as const;

// Typical visible output tokens for each OUTPUT_LENGTH level.
export const OUTPUT_TOKENS_BY_LEVEL = [120, 600, 2500, 8000] as const;

// Reasoning effort ladder, lowest -> highest. OpenRouter's `reasoning.effort` values,
// plus "default" for models without an effort control.
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number] | 'default';

// Fraction of a model's full reasoning benefit realised at each effort level.
export const EFFORT_BENEFIT: Record<Effort, number> = {
  none: 0,
  minimal: 0.25,
  low: 0.5,
  medium: 0.75,
  high: 0.9,
  xhigh: 0.97,
  max: 1,
  default: 0.8,
};

// Expected reasoning tokens at each effort for a "Hard" task that needs extensive deliberation.
// Scaled down for easier / shallower tasks in the estimator.
export const REASONING_TOKENS: Record<Effort, number> = {
  none: 0,
  minimal: 300,
  low: 1200,
  medium: 3500,
  high: 8000,
  xhigh: 14000,
  max: 24000,
  default: 3000,
};

// How much skill (in capability points) a task category gains from full reasoning.
// Math gains a lot from thinking; casual chat gains almost nothing.
export const REASONING_SENSITIVITY: Record<TaskType, number> = {
  math: 1.0,
  reasoning: 0.9,
  coding_debug: 0.8,
  coding_refactor: 0.8,
  coding_generate: 0.6,
  agentic: 0.6,
  coding_explain: 0.4,
  research: 0.4,
  extraction: 0.2,
  writing: 0.15,
  chat: 0.1,
};
export const MAX_REASONING_GAIN_POINTS = 15;

// Intelligence-Index points (~20-60 for current models) -> capability points on the scale of
// DIFFICULTY_THRESHOLDS. Provisional: our own evals will fit this against observed success rates.
export const INDEX_TO_SKILL = 1.45;

// Skill (0-100) a model needs to have a 50% chance of succeeding at each difficulty level.
// Provisional calibration against the ingested skill scale (frontier ~80-85, mid-tier ~60-68, cheap
// fast models ~50-57): a mid-tier model handles Moderate tasks ~95% of the time and Hard ones ~65%.
// The eval phase should fit these (and INDEX_TO_SKILL) to observed success rates.
export const DIFFICULTY_THRESHOLDS = [5, 30, 45, 62, 76] as const;
// Width of the success curve around the threshold (larger = more forgiving).
export const SUCCESS_CURVE_WIDTH = 6;

export const MODES = ['cheap', 'balanced', 'best'] as const;
export type Mode = (typeof MODES)[number];

// What a successful answer to a Moderate task is worth (USD) and what a second of waiting costs, per mode.
// score = P(success) * value - cost - latency_seconds * valuePerSecond
export const MODE_WEIGHTS: Record<Mode, { valueUsd: number; latencyUsdPerSec: number }> = {
  cheap: { valueUsd: 0.02, latencyUsdPerSec: 0.00005 },
  balanced: { valueUsd: 0.3, latencyUsdPerSec: 0.0015 },
  best: { valueUsd: 10, latencyUsdPerSec: 0 },
};

// Solving a hard problem is worth far more than answering a greeting, so the value of a
// success scales with difficulty (Moderate = 1).
export const DIFFICULTY_VALUE = [0.05, 0.25, 1, 2.5, 5] as const;

// Candidates whose success chance is below this fraction of the best achievable chance rank last:
// the router never knowingly picks a near-certain failure just because it is cheap.
export const QUALITY_FLOOR_RATIO = 0.5;

// Capability dimensions stored in the capability database, per model x effort level. A request's
// requirements are expressed as weights over these (from the task type + Jev's importance scores),
// so routing matches specific abilities rather than broad task tags.
export const CAPABILITIES = {
  code_generation: 'Writing correct new code from a specification.',
  code_debugging: 'Diagnosing and fixing bugs and failing tests in an existing codebase, often via a terminal.',
  software_engineering: 'Long-horizon, repository-scale engineering: multi-file changes, migrations, large refactors.',
  math: 'Mathematical problem solving and proofs.',
  reasoning: 'Hard multi-step reasoning and expert knowledge (science, logic, analysis).',
  long_context: 'Reasoning accurately over very long inputs (100K+ tokens).',
  agentic_tool_use: 'Using tools and APIs reliably across multi-step workflows.',
  computer_use: 'Operating software through screenshots, clicks and keyboard (GUI agents).',
  web_research: 'Finding, reading and synthesising information from the web.',
  vision: 'Understanding images, charts, screenshots and video.',
  instruction_following: 'Following precise instructions, formats and constraints.',
  writing: 'High-quality prose: creative, persuasive and professional writing.',
  conversation: 'Helpful, natural conversational answers that people prefer.',
  knowledge_work: 'Professional deliverables and domain work: finance, legal, business, health.',
  document_understanding: 'Reading and extracting from PDFs, reports and dense documents.',
  science: 'Scientific research workflows: data analysis, simulation, lab and bioinformatics tasks.',
} as const;
export type Capability = keyof typeof CAPABILITIES;
export const CAPABILITY_KEYS = Object.keys(CAPABILITIES) as Capability[];
export type Dimension = Capability;

// Which benchmarks measure each capability, and how much each counts. Keys are benchmark ids as stored
// in benchmark_results (Artificial Analysis field names, lmarena_* categories, vendor-report ids).
// Missing benchmarks are imputed from the variant's Intelligence Index; trust records real coverage.
export const DIMENSION_BENCHMARKS: Record<Capability, Record<string, number>> = {
  code_generation: { artificial_analysis_coding_index: 2, scicode: 1, livecodebench: 1, frontiercode_main: 1, frontiercode_extended: 0.5, lmarena_coding: 1 },
  code_debugging: { terminalbench_hard: 1.5, terminalbench_v2_1: 1.5, terminalbench_4: 1.5, deepswe_1_1: 1, cursorbench_4: 1, artificial_analysis_coding_index: 0.5 },
  software_engineering: { deepswe_1_1: 2, terminalbench_4: 1.5, cursorbench_4: 1, frontiercode_extended: 1, terminalbench_hard: 1, lcr: 0.5 },
  math: { artificial_analysis_math_index: 2, aime_25: 1, aime: 1, math_500: 0.5, frontiermath_t4: 1, lmarena_math: 1, hle: 0.5 },
  reasoning: { gpqa: 1, hle: 1, gpqa_diamond: 0.5, hle_verified: 0.5, hle_tools: 0.5, arc_agi_2: 0.5, mmlu_pro: 0.5, lmarena_hard_prompts: 1 },
  long_context: { lcr: 2, mrcr_8needle_256k_512k: 1, mrcr_8needle_512k_1m: 1 },
  agentic_tool_use: { tau2: 1.5, tau_banking: 1, automationbench: 1, agents_last_exam: 1, terminalbench_hard: 0.5 },
  computer_use: { osworld_2: 2, screenspot_pro: 1, agents_last_exam: 0.5 },
  web_research: { browsecomp: 2, hle_tools: 0.5 },
  vision: { mmmu_pro: 1, charxiv_reasoning: 1, chartography: 1, screenspot_pro: 0.5, lvbench: 0.5 },
  instruction_following: { ifbench: 2, lmarena_instruction_following: 1 },
  writing: { lmarena_creative_writing: 2, gdpval_aa_v2_1_elo: 0.5, gdpval_aa_v2_elo: 0.5, ifbench: 0.3 },
  conversation: { lmarena_text: 2, lmarena_hard_prompts: 0.5, ifbench: 0.3 },
  knowledge_work: { gdpval_aa_v2_1_elo: 1, gdpval_aa_v2_elo: 1, vals_finance_agent_2: 0.5, harvey_legal_agent: 0.5, healthbench_pro: 0.5, automationbench: 0.5 },
  document_understanding: { gdp_pdf: 1.5, lcr: 0.5, charxiv_reasoning: 0.5, ifbench: 0.3 },
  science: { terminalbench_science: 1.5, scicode: 1, gpqa: 0.5, healthbench_pro: 0.5 },
};

// Default capability mix for each task type. Jev's per-capability importance scores are added on top.
export const TASK_CAPABILITY_MIX: Record<TaskType, Partial<Record<Capability, number>>> = {
  coding_generate: { code_generation: 1 },
  coding_debug: { code_debugging: 1, code_generation: 0.3 },
  coding_refactor: { software_engineering: 1, code_debugging: 0.3 },
  coding_explain: { code_generation: 0.5, reasoning: 0.5 },
  math: { math: 1, reasoning: 0.3 },
  reasoning: { reasoning: 1 },
  writing: { writing: 1, instruction_following: 0.3 },
  extraction: { document_understanding: 0.7, instruction_following: 0.5 },
  research: { web_research: 1, reasoning: 0.3 },
  agentic: { agentic_tool_use: 1 },
  chat: { conversation: 1 },
};

// Capabilities Jev rates by importance for each request (score: not needed / helpful / important / critical).
export const JEV_CAPABILITY_QUESTIONS: Partial<Record<Capability, string>> = {
  long_context: 'reading and reasoning over a very long document, codebase or conversation provided in the request',
  agentic_tool_use: 'calling tools or APIs over several steps to get the job done',
  computer_use:
    'the model itself taking actions in a graphical interface: clicking, typing and navigating apps or websites on screen. Only analysing a screenshot or image does not count, nor does writing code, calling APIs or searching the web',
  web_research: 'looking up current or external information on the web',
  vision: 'understanding images, screenshots, charts or video',
  instruction_following: 'following strict formats, constraints or detailed instructions exactly',
  writing: 'polished, high-quality prose or creative writing',
  knowledge_work: 'professional domain expertise such as finance, law, medicine or business analysis',
  math: 'mathematical problem solving',
  software_engineering: 'large multi-file or repository-wide code changes',
  science: 'scientific research or data-analysis workflows',
};

// How much a benchmark report counts relative to an independent measurement.
export const SOURCE_QUALITY = { independent: 1, vendor: 0.6 } as const;

// Each capability starts from the variant's Intelligence Index as a prior with this weight; every
// benchmark then adds evidence = relevance weight x source quality x equating reliability. So one strong,
// relevant benchmark (weight 2) outweighs the prior, a weakly related one barely moves it.
export const INDEX_PRIOR_WEIGHT = 0.75;
// Evidence that counts as full coverage for trust purposes (one definitive independent benchmark).
export const FULL_EVIDENCE = 2;

// Generalised-mean exponent used to combine required capabilities: negative values make the weakest
// important capability dominate (a model that cannot do a critical part of the task should not win).
export const CAPABILITY_MEAN_EXPONENT = -3;
