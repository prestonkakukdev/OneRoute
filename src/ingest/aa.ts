import { config } from '../config.js';
import type { Effort } from '../taxonomy.js';
import type { VariantMetrics } from '../types.js';
import { effortFromText, ModelResolver, type Resolved } from './resolve.js';

export const AA_SOURCE = 'artificialanalysis.ai';

// One entry of the free GET /api/v2/data/llms/models endpoint. Each AA effort variant is its own entry.
export interface AaModel {
  id: string;
  name: string;
  slug: string;
  release_date?: string | null;
  model_creator?: { slug?: string; name?: string } | null;
  evaluations?: Record<string, number | null> | null;
  pricing?: Record<string, number | null> | null;
  median_output_tokens_per_second?: number | null;
  median_time_to_first_token_seconds?: number | null;
  median_time_to_first_answer_token?: number | null;
}

export async function fetchAaModels(fetchImpl: typeof fetch = fetch): Promise<AaModel[]> {
  if (!config.aaKey) throw new Error('ARTIFICIAL_ANALYSIS_API_KEY is not set (add it to .env).');
  const res = await fetchImpl(`${config.aaBaseUrl}/data/llms/models`, { headers: { 'x-api-key': config.aaKey } });
  if (!res.ok) throw new Error(`Artificial Analysis API returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { data: AaModel[] }).data;
}

const EFFORT_SUFFIX = /-(non-reasoning|reasoning|minimal|low|medium|high|xhigh|max)$/;

// AA names variants like "Claude Opus 5.5 (Adaptive Reasoning, Max Effort)" or "GPT-6 Sol (high)".
// The effort is read only from the parenthetical: a slug such as "qwen3-8-max" names a model, not an effort.
export function parseVariant(m: Pick<AaModel, 'name' | 'slug'>): { base: string; effort?: Effort; tag?: string } {
  const paren = /\(([^)]*)\)/.exec(m.name)?.[1] ?? '';
  const effort = effortFromText(paren);
  const base = effort ? m.slug.replace(EFFORT_SUFFIX, '') : m.slug;
  const tag = /^\d{4}$/.test(paren.trim()) ? paren.trim() : undefined; // "(0902)" snapshot tag
  return { base, effort, tag };
}

export const cleanEvals = (m: AaModel): Record<string, number> =>
  Object.fromEntries(Object.entries(m.evaluations ?? {}).filter((e): e is [string, number] => typeof e[1] === 'number'));

// Time to first token without any thinking (network + prefill), used to separate thinking time.
const BASE_TTFT_S = 1.0;

// AA times a ~1K-token prompt. Providers that hide reasoning (Anthropic, OpenAI, Google) include the
// thinking time in time-to-first-token; providers that stream it (DeepSeek, GLM, Kimi) show it as the
// gap before the first answer token. Either way: thinking time = first answer token - base latency.
export function metricsOf(m: AaModel, measuredAt: string): VariantMetrics | undefined {
  const tps = m.median_output_tokens_per_second || undefined;
  const ttft = m.median_time_to_first_token_seconds || undefined;
  const ttfat = m.median_time_to_first_answer_token || ttft;
  if (!tps || !ttft || !ttfat) return undefined;
  const base = Math.min(ttft, BASE_TTFT_S);
  return { tps, ttftS: base, reasoningTokensRef: Math.round(Math.max(0, ttfat - base) * tps), source: AA_SOURCE, measuredAt };
}

export interface AaMatch extends Resolved {
  aa: AaModel;
}

// Maps AA variants onto OpenRouter model ids + effort levels; keeps one AA variant per (model, effort):
// the newest, then the one with the most benchmarks.
export function matchVariants(aa: AaModel[], resolver: ModelResolver) {
  const matches: AaMatch[] = [];
  const unmatched: AaModel[] = [];
  for (const v of aa) {
    const { base, effort, tag } = parseVariant(v);
    const r = resolver.resolve(base, effort, { tag, aliases: [v.slug] });
    if (r) matches.push({ ...r, aa: v });
    else unmatched.push(v);
  }
  const rank = (m: AaMatch) => `${m.aa.release_date ?? ''}|${String(Object.keys(cleanEvals(m.aa)).length).padStart(3, '0')}`;
  const best = new Map<string, AaMatch>();
  for (const m of matches) {
    const key = `${m.orId}|${m.effort}`;
    const cur = best.get(key);
    if (!cur || rank(m) > rank(cur)) best.set(key, m);
  }
  return { matches: [...best.values()], unmatched };
}
