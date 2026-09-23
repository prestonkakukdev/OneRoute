import { readFileSync } from 'node:fs';
import { parseOpenRouterModel, type OpenRouterModel } from '../providers/openrouter.js';
import type { Effort } from '../taxonomy.js';

// "anthropic/claude-opus-5.5:beta" -> "claude-opus-5-5"
export const orTail = (id: string) => id.split('/')[1]!.split(':')[0]!.toLowerCase().replace(/[^a-z0-9]+/g, '-');
export const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const EFFORT_WORDS: [Effort, RegExp][] = [
  ['none', /non[- ]?reasoning|reasoning[- ]off|no[- ]reasoning/i],
  ['xhigh', /\bx[- ]?high\b|extra[- ]high/i],
  ['max', /\bmax(imum)?\b/i],
  ['high', /\bhigh\b/i],
  ['medium', /\bmedium\b/i],
  ['minimal', /\bminimal\b/i],
  ['low', /\blow\b/i],
];
export const effortFromText = (text: string): Effort | undefined => EFFORT_WORDS.find(([, re]) => re.test(text))?.[0];

export interface Resolved {
  orId: string;
  effort: Effort;
  efforts: Effort[];
}

export function loadOverrides(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(new URL('../../data/model-map.json', import.meta.url), 'utf8')).overrides ?? {};
  } catch {
    return {};
  }
}

// Maps a source's model name (already split into base slug + effort) onto an OpenRouter model.
// Exact slug match first, then a dated OpenRouter snapshot ("deepseek-v4-pro-0813" for "deepseek-v4-pro"),
// then manual overrides. Ambiguous names are left unresolved rather than guessed.
export class ModelResolver {
  private readonly byTail = new Map<string, OpenRouterModel[]>();
  private readonly byId: Map<string, OpenRouterModel>;

  constructor(
    or: OpenRouterModel[],
    private readonly overrides: Record<string, string> = loadOverrides(),
  ) {
    for (const m of or) {
      if (m.id.includes(':')) continue;
      const list = this.byTail.get(orTail(m.id)) ?? [];
      list.push(m);
      this.byTail.set(orTail(m.id), list);
    }
    this.byId = new Map(or.map((m) => [m.id, m]));
  }

  model(id: string): OpenRouterModel | undefined {
    return this.byId.get(id);
  }

  resolve(base: string, effort?: Effort, opts: { tag?: string; aliases?: string[] } = {}): Resolved | undefined {
    const target = this.find(base, opts.tag, opts.aliases ?? []);
    if (!target) return undefined;
    const meta = parseOpenRouterModel(target);
    const e = effort ?? meta.defaultEffort;
    if (!meta.efforts.includes(e)) return undefined; // measured at an effort OpenRouter does not expose
    return { orId: target.id, effort: e, efforts: meta.efforts };
  }

  private find(base: string, tag: string | undefined, aliases: string[]): OpenRouterModel | undefined {
    for (const key of [...aliases, base]) {
      const id = this.overrides[key];
      if (id && this.byId.has(id)) return this.byId.get(id);
    }
    for (const t of [tag ? `${base}-${tag}` : '', base].filter(Boolean)) {
      const hit = this.byTail.get(t);
      if (hit?.length === 1) return hit[0];
    }
    const dated = [...this.byTail.entries()].filter(([t]) => new RegExp(`^${base}-\\d{4}$`).test(t)).flatMap(([, m]) => m);
    return dated.length === 1 ? dated[0] : undefined;
  }
}
