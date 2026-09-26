import { config } from '../config.js';
import { EFFORTS, type Effort } from '../taxonomy.js';
import type { LongContextPrice, ModelRecord, Pricing } from '../types.js';

// Raw shape of an entry in OpenRouter's GET /models response (fields we use).
export interface OpenRouterModel {
  id: string;
  name: string;
  created?: number;
  hugging_face_id?: string | null;
  context_length: number;
  architecture?: { input_modalities?: string[] };
  pricing: Record<string, unknown>;
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
  reasoning?: { mandatory?: boolean; supported_efforts?: string[]; default_effort?: string } | null;
}

type ModelMetadata = Pick<
  ModelRecord,
  | 'id'
  | 'name'
  | 'provider'
  | 'contextLength'
  | 'maxOutput'
  | 'inputModalities'
  | 'supportedParams'
  | 'pricing'
  | 'efforts'
  | 'reasoningMandatory'
  | 'defaultEffort'
  | 'openWeights'
>;

const price = (v: unknown): number | undefined => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

export function parsePricing(raw: Record<string, unknown>): Pricing {
  const output = price(raw.completion) ?? 0;
  const overrides = Array.isArray(raw.overrides) ? (raw.overrides as Record<string, unknown>[]) : [];
  const longContext: LongContextPrice[] = overrides
    .filter((o) => price(o.min_prompt_tokens) !== undefined)
    .map((o) => ({
      minPromptTokens: price(o.min_prompt_tokens)!,
      inputPerTok: price(o.prompt) ?? price(raw.prompt) ?? 0,
      outputPerTok: price(o.completion) ?? output,
      cacheReadPerTok: price(o.input_cache_read),
    }));
  return {
    inputPerTok: price(raw.prompt) ?? 0,
    outputPerTok: output,
    reasoningPerTok: price(raw.internal_reasoning) ?? output,
    cacheReadPerTok: price(raw.input_cache_read),
    cacheWritePerTok: price(raw.input_cache_write),
    cacheWrite1hPerTok: price(raw.input_cache_write_1h),
    webSearchPerCall: price(raw.web_search),
    longContext: longContext.length ? longContext : undefined,
  };
}

export function parseEfforts(raw: OpenRouterModel): Pick<ModelRecord, 'efforts' | 'reasoningMandatory' | 'defaultEffort'> {
  const params = raw.supported_parameters ?? [];
  const supported = (raw.reasoning?.supported_efforts ?? []).filter((e): e is Effort =>
    (EFFORTS as readonly string[]).includes(e),
  );
  if (!params.includes('reasoning') || supported.length === 0) {
    return { efforts: ['default'], reasoningMandatory: false, defaultEffort: 'default' };
  }
  const mandatory = raw.reasoning?.mandatory === true;
  const efforts = new Set<Effort>(supported);
  // Non-mandatory reasoning can be switched off entirely.
  if (!mandatory) efforts.add('none');
  const ordered: Effort[] = EFFORTS.filter((e) => efforts.has(e));
  const def = raw.reasoning?.default_effort as Effort | undefined;
  return {
    efforts: ordered,
    reasoningMandatory: mandatory,
    defaultEffort: def && ordered.includes(def) ? def : ordered[ordered.length - 1]!,
  };
}

export function parseOpenRouterModel(raw: OpenRouterModel): ModelMetadata {
  return {
    id: raw.id,
    name: raw.name,
    provider: raw.id.split('/')[0] ?? 'unknown',
    contextLength: raw.context_length,
    maxOutput: raw.top_provider?.max_completion_tokens ?? Math.min(raw.context_length, 32000),
    inputModalities: raw.architecture?.input_modalities ?? ['text'],
    supportedParams: raw.supported_parameters ?? [],
    pricing: parsePricing(raw.pricing),
    // OpenRouter links a Hugging Face repo only for models whose weights are published.
    openWeights: Boolean(raw.hugging_face_id),
    ...parseEfforts(raw),
  };
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://github.com/prestonkakukdev/System1-Route',
    'X-Title': 'System1 Route',
  };
  if (config.openRouterKey) h.Authorization = `Bearer ${config.openRouterKey}`;
  return h;
}

export async function fetchModels(): Promise<OpenRouterModel[]> {
  const res = await fetch(`${config.openRouterBaseUrl}/models`, { headers: headers() });
  if (!res.ok) throw new Error(`OpenRouter /models failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data: OpenRouterModel[] };
  return body.data;
}

// Misconfiguration: retrying another model cannot help.
export class ConfigError extends Error {}

export function requireOpenRouterKey(): void {
  if (!config.openRouterKey) throw new ConfigError('OPENROUTER_API_KEY is not set (add it to .env).');
}

// Raw passthrough so callers can stream or buffer.
export async function chatCompletion(body: unknown, signal?: AbortSignal): Promise<Response> {
  requireOpenRouterKey();
  return fetch(`${config.openRouterBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  });
}
