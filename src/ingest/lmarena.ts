import type { Effort } from '../taxonomy.js';
import { effortFromText, slugify, type ModelResolver } from './resolve.js';
import type { ExternalResult } from './vendor.js';

export const LMARENA_SOURCE = 'lmarena.ai';

// Benchmark id -> leaderboard path. Ratings are blind human-preference Elo scores (independent).
export const LMARENA_CATEGORIES: Record<string, string> = {
  lmarena_text: 'text',
  lmarena_creative_writing: 'text/creative-writing',
  lmarena_instruction_following: 'text/instruction-following',
  lmarena_coding: 'text/coding',
  lmarena_math: 'text/math',
  lmarena_hard_prompts: 'text/hard-prompts',
};

export interface ArenaRating {
  name: string;
  rating: number;
  lower: number;
  upper: number;
  votes: number;
}

// The leaderboard page embeds its data as escaped JSON; each entry carries name, rating, CI and votes.
const ENTRY = /\\"modelDisplayName\\":\\"([^\\"]+)\\",\\"rating\\":([\d.]+),\\"ratingUpper\\":([\d.]+),\\"ratingLower\\":([\d.]+),\\"votes\\":(\d+)/g;

export function parseArenaPage(html: string): ArenaRating[] {
  const seen = new Map<string, ArenaRating>();
  for (const m of html.matchAll(ENTRY)) {
    if (!seen.has(m[1]!)) seen.set(m[1]!, { name: m[1]!, rating: +m[2]!, upper: +m[3]!, lower: +m[4]!, votes: +m[5]! });
  }
  return [...seen.values()];
}

export async function fetchArenaCategory(path: string, fetchImpl: typeof fetch = fetch): Promise<ArenaRating[]> {
  const res = await fetchImpl(`https://arena.ai/leaderboard/${path}`, { headers: { 'User-Agent': 'Mozilla/5.0 system1-route' } });
  if (!res.ok) throw new Error(`LMArena ${path} returned ${res.status}`);
  return parseArenaPage(await res.text());
}

// "claude-opus-5-high" -> claude-opus-5 @ high; "muse-spark-1.2 (xHigh)" -> muse-spark-1-2 @ xhigh;
// "deepseek-v4-pro-high-20260813" -> deepseek-v4-pro @ high. No effort named -> the model's default.
export function parseArenaName(name: string): { base: string; effort?: Effort } {
  const paren = /\(([^)]*)\)/.exec(name)?.[1] ?? '';
  let s = slugify(name.replace(/\([^)]*\)/g, ''))
    .replace(/-\d{8}$/, '')
    .replace(/-(thinking-)?\d+k$/, '');
  let effort = effortFromText(paren);
  const m = /-(minimal|low|medium|high|xhigh|max)$/.exec(s);
  if (m) {
    effort ??= m[1] as Effort;
    s = s.slice(0, m.index);
  }
  return { base: s.replace(/-\d{8}$/, ''), effort };
}

// Ratings -> external results for the models the resolver can identify. Ratings with too few votes
// (wide confidence interval) are skipped.
export function arenaResults(benchmark: string, ratings: ArenaRating[], resolver: ModelResolver, measuredAt: string, minVotes = 500) {
  const results: ExternalResult[] = [];
  const unresolved: string[] = [];
  for (const r of ratings) {
    if (r.votes < minVotes) continue;
    // The full name first ("qwen3.8-max" is a model), then with a trailing effort word stripped.
    const { base, effort } = parseArenaName(r.name);
    const full = slugify(r.name.replace(/\([^)]*\)/g, '')).replace(/-\d{8}$/, '');
    const resolved = (full !== base && resolver.resolve(full, undefined)) || resolver.resolve(base, effort, { aliases: [slugify(r.name)] });
    if (!resolved) {
      unresolved.push(r.name);
      continue;
    }
    results.push({
      orId: resolved.orId,
      effort: resolved.effort,
      benchmark,
      value: r.rating,
      source: LMARENA_SOURCE,
      sourceRef: `https://arena.ai/leaderboard/${LMARENA_CATEGORIES[benchmark]}`,
      independent: true,
      measuredAt,
    });
  }
  return { results, unresolved };
}
