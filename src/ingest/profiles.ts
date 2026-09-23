import { createHash } from 'node:crypto';
import { config } from '../config.js';
import type { Store } from '../db/store.js';
import { chatCompletion } from '../providers/openrouter.js';
import { CAPABILITY_KEYS, type Dimension, type Effort } from '../taxonomy.js';
import type { ModelRecord } from '../types.js';

const DIMS: Dimension[] = CAPABILITY_KEYS;
const topEffort = (m: ModelRecord): Effort => m.efforts[m.efforts.length - 1]!;
const skillAt = (m: ModelRecord, e: Effort, d: Dimension) => m.variantSkills[e]?.[d] ?? m.skills[d];

// Hash of everything a profile describes: when it changes, the profile is regenerated.
export function dataHash(m: ModelRecord): string {
  const payload = {
    price: [m.pricing.inputPerTok, m.pricing.outputPerTok],
    context: m.contextLength,
    inputs: m.inputModalities,
    tools: m.supportedParams.includes('tools'),
    efforts: m.efforts,
    skills: m.efforts.map((e) => DIMS.map((d) => Math.round(skillAt(m, e, d)?.skill ?? -1))),
    speed: m.efforts.map((e) => Math.round(m.variantMetrics[e]?.tps ?? -1)),
    live: m.providerStats ? Math.round(Math.log2(m.providerStats.tps) * 2) : -1, // coarse, so live noise does not force a rewrite
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

// Percentile of `value` among all enabled models at their top effort, so the writer can say
// "strong" or "weak" relative to the field instead of guessing from raw numbers.
function percentile(all: ModelRecord[], d: Dimension, value: number): number {
  const vals = all.map((m) => skillAt(m, topEffort(m), d)?.skill).filter((v): v is number => v !== undefined);
  return Math.round((100 * vals.filter((v) => v < value).length) / Math.max(vals.length, 1));
}

export function profilePrompt(m: ModelRecord, all: ModelRecord[]): string {
  const top = topEffort(m);
  const low = m.efforts[0]!;
  const rows = DIMS.map((d) => {
    const t = skillAt(m, top, d);
    const l = skillAt(m, low, d);
    if (!t) return `${d}: no data`;
    const measured = t.source.startsWith('imputed') ? 'NOT directly measured (estimated from overall index)' : t.trust >= 0.5 ? 'measured' : 'measured by few benchmarks';
    return `${d}: ${t.skill.toFixed(0)} at ${top} (percentile ${percentile(all, d, t.skill)}), ${l ? `${l.skill.toFixed(0)} at ${low}` : ''}; ${measured}`;
  });
  const inPrices = all.map((x) => x.pricing.inputPerTok).sort((a, b) => a - b);
  const pricePct = Math.round((100 * inPrices.filter((p) => p < m.pricing.inputPerTok).length) / inPrices.length);
  const speeds =
    m.efforts.map((e) => `${e} ${m.variantMetrics[e]?.tps?.toFixed(0) ?? '?'} tok/s`).join(', ') +
    (m.providerStats ? `; live median across providers ${m.providerStats.tps.toFixed(0)} tok/s, uptime ${(m.providerStats.uptime * 100).toFixed(1)}%` : '');
  return [
    `Write a routing profile for the model ${m.id}: 2-3 plain sentences, no preamble, no markdown.`,
    'Style example: "Very strong at repository-scale coding and debugging, benefits heavily from high reasoning effort, relatively expensive, weak at computer use."',
    'Rules: use ONLY the data below. Say strong/weak relative to the percentiles. Mention how much it gains from higher reasoning effort.',
    'Say plainly when a capability is only weakly measured. Never mention a capability that has no data, except to say it is unmeasured.',
    '',
    `Price: $${(m.pricing.inputPerTok * 1e6).toFixed(2)} in / $${(m.pricing.outputPerTok * 1e6).toFixed(2)} out per 1M tokens (price percentile ${pricePct}; higher = more expensive).`,
    `Context window: ${Math.round(m.contextLength / 1000)}K tokens. Inputs: ${m.inputModalities.join(', ')}. Tool calling: ${m.supportedParams.includes('tools') ? 'yes' : 'no'}.`,
    `Reasoning effort levels: ${m.efforts.join(', ')}. Speed: ${speeds}.`,
    'Capability scores (0-100 scale, from Artificial Analysis, LMArena and vendor benchmarks):',
    ...rows,
  ].join('\n');
}

export interface ProfileRun {
  generated: string[];
  unchanged: number;
  failed: { id: string; error: string }[];
}

// Step 3: regenerate profiles only for models whose data changed since the last profile.
export async function generateProfiles(
  store: Store,
  opts: { force?: boolean; only?: string[]; llm?: typeof chatCompletion; concurrency?: number } = {},
): Promise<ProfileRun> {
  const llm = opts.llm ?? chatCompletion;
  const all = store.listModels();
  const run: ProfileRun = { generated: [], unchanged: 0, failed: [] };
  const todo = all.filter((m) => {
    if (opts.only?.length && !opts.only.includes(m.id)) return false;
    if (!opts.force && store.getProfile(m.id)?.dataHash === dataHash(m)) {
      run.unchanged++;
      return false;
    }
    return true;
  });
  const worker = async () => {
    for (let m = todo.shift(); m; m = todo.shift()) await writeProfile(m);
  };
  const writeProfile = async (m: ModelRecord) => {
    const hash = dataHash(m);
    try {
      const res = await llm({
        model: config.profileModel,
        messages: [{ role: 'user', content: profilePrompt(m, all) }],
        reasoning: { effort: 'low' },
        max_tokens: 1500,
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = body.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('empty profile');
      store.setProfile(m.id, text, hash, config.profileModel);
      run.generated.push(m.id);
    } catch (err) {
      run.failed.push({ id: m.id, error: (err as Error).message });
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 8 }, worker));
  return run;
}
