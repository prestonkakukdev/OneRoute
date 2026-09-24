import type { Capability, Dimension, Effort, Mode, TaskType } from './taxonomy.js';

export interface LongContextPrice {
  minPromptTokens: number;
  inputPerTok: number;
  outputPerTok: number;
  cacheReadPerTok?: number;
}

export interface Pricing {
  inputPerTok: number;
  outputPerTok: number;
  reasoningPerTok: number;
  cacheReadPerTok?: number;
  webSearchPerCall?: number;
  longContext?: LongContextPrice[];
}

export interface SkillValue {
  skill: number; // 0-100 capability points, measured at the model's top effort
  source: string;
  trust: number; // 0-1: how much we believe the source
  samples: number;
  updatedAt: string;
}

export interface VariantMetrics {
  tps?: number;
  ttftS?: number;
  // Reasoning tokens spent on the source's standard ~1K-token prompt: (time to first answer - time to first token) x tps.
  reasoningTokensRef?: number;
  source: string;
  measuredAt: string;
}

export interface ModelRecord {
  id: string;
  name: string;
  provider: string;
  openWeights: boolean;
  enabled: boolean;
  contextLength: number;
  maxOutput: number;
  inputModalities: string[];
  supportedParams: string[];
  pricing: Pricing;
  efforts: Effort[];
  reasoningMandatory: boolean;
  defaultEffort: Effort;
  effortGain: number; // multiplier on how much this model benefits from reasoning
  tps: number; // output tokens per second
  ttftMs: number;
  // Skill at the model's top effort; lower efforts derived by the effort curve (bootstrap priors only).
  skills: Partial<Record<Dimension, SkillValue>>;
  // Per-effort skills (measured, or filled from the measured population effort curve). These win.
  variantSkills: Partial<Record<Effort, Partial<Record<Dimension, SkillValue>>>>;
  // Measured speed per effort level.
  variantMetrics: Partial<Record<Effort, VariantMetrics>>;
  // Live production speed and reliability across providers (OpenRouter).
  providerStats?: { tps: number; latencyS: number; uptime: number; providers: number; requests: number; measuredAt: string };
  profile?: string;
  notes?: string;
  updatedAt: string;
}

export interface Distribution<K extends string | number> {
  value: K;
  probabilities: Record<K, number>;
  confidence: number;
}

export interface TaskProfile {
  taskType: Distribution<TaskType>;
  difficulty: Distribution<number>; // levels 0-4
  reasoningDepth: Distribution<number>; // levels 0-3
  outputLength: Distribution<number>; // levels 0-3
  // How important each capability is for this request, 0 (not needed) to 1 (critical).
  capabilities: Partial<Record<Capability, number>>;
  needsWeb: number; // probability
  latencySensitive: number;
  highStakes: number;
  underspecified?: number; // probability the request cannot be acted on without clarification
  source: 'jev' | 'heuristic';
  latencyMs: number;
  error?: string;
}

export interface RequestFacts {
  inputTokens: number;
  prefixTokens: number; // tokens before the latest user message (cacheable on a sticky model)
  hasImages: boolean;
  hasFiles: boolean;
  hasAudio: boolean;
  toolsPresent: boolean;
  jsonSchemaRequired: boolean;
  requestedMaxTokens?: number;
}

// User preferences that steer the optimizer (not Jev). Weights default to 1; the mode sets the baseline.
export interface Preferences {
  qualityWeight: number; // >1 = willing to pay more for a better answer ("sacrifice cost for intelligence")
  costWeight: number; // >1 = more cost-conscious
  speedWeight: number; // >1 = more impatient
  openWeights: 'any' | 'prefer' | 'only';
  preferProviders: string[]; // e.g. ['anthropic', 'google']
  avoidProviders: string[];
  minQuality: number; // 0-100: never choose a model whose skill for the request is below this
}

export interface RoutePrefs {
  mode: Mode;
  preferences: Preferences;
  maxCostUsd?: number;
  maxLatencyS?: number;
  allowModels?: string[];
  denyModels?: string[];
  web?: 'auto' | 'on' | 'off';
  escalation?: 'auto' | 'off';
  sessionId?: string;
}

export interface Candidate {
  modelId: string;
  effort: Effort;
  pSuccess: number;
  estCostUsd: number;
  estLatencyS: number;
  utility: number;
  skill?: number; // effective skill for this request (0-100)
  // Score components in USD: utility = value + quality - cost - latency - preference
  breakdown?: { value: number; quality: number; cost: number; latency: number; preference: number };
}

export interface Escalation {
  reasons: string[];
  by: 'llm' | 'conservative';
  rationale?: string;
  latencyMs: number;
}

export interface RouteDecision {
  requestId: string;
  modelId: string;
  effort: Effort;
  mode: Mode;
  useWeb: boolean;
  task: TaskProfile;
  facts: RequestFacts;
  candidates: Candidate[]; // ranked, best first
  escalation: Escalation | null;
  sessionId?: string;
  stickyModel?: string;
  preferences?: Preferences;
  needs?: Partial<Record<Capability, number>>; // requirement weights for the most likely task type
  webReason?: string; // why web search was switched on or off
  rejected?: Record<string, string>; // model -> reason it failed a hard requirement
  routeMs: number;
}

// Minimal OpenAI-compatible chat request shape (extra fields are passed through untouched).
export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  [key: string]: unknown;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } | string }
  | { type: 'file'; file: unknown }
  | { type: 'input_audio'; input_audio: unknown }
  | { type: string; [key: string]: unknown };

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: unknown[];
  response_format?: { type: string; [key: string]: unknown };
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  router?: Partial<RoutePrefs>;
  [key: string]: unknown;
}
