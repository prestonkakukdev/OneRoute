import { readFileSync } from 'node:fs';
import { parseOpenRouterModel, type OpenRouterModel } from '../providers/openrouter.js';
import { CAPABILITY_KEYS, INDEX_TO_SKILL, type Capability, type Dimension } from '../taxonomy.js';
import type { ModelRecord, SkillValue } from '../types.js';

interface SeedFile {
  source: { name: string; fetchedAt: string; trust: number };
  models: { id: string; intelligence: number; coding: number | null; tps: number; ttftMs: number }[];
}

const dataFile = (name: string) => new URL(`../../data/${name}`, import.meta.url);

export function loadSeed(): SeedFile {
  return JSON.parse(readFileSync(dataFile('seed.json'), 'utf8')) as SeedFile;
}

export function loadSnapshot(): OpenRouterModel[] {
  return (JSON.parse(readFileSync(dataFile('openrouter-snapshot.json'), 'utf8')) as { data: OpenRouterModel[] }).data;
}


const CODING = new Set<Capability>(['code_generation', 'code_debugging', 'software_engineering']);

// Bootstrap priors (used only before the first `oneroute ingest`): coding capabilities from the coding
// index, everything else from the general index.
export function priorSkills(intelligence: number, coding: number | null, source: string, trust: number, at: string) {
  const general = intelligence * INDEX_TO_SKILL;
  const codingSkill = coding === null ? general : (general + coding) / 2;
  const skills: Partial<Record<Dimension, SkillValue>> = {};
  for (const t of CAPABILITY_KEYS) {
    skills[t] = {
      skill: Math.round((CODING.has(t) ? codingSkill : general) * 10) / 10,
      source,
      trust,
      samples: 0,
      updatedAt: at,
    };
  }
  return skills;
}

export function buildSeedModels(): ModelRecord[] {
  const seed = loadSeed();
  const snapshot = new Map(loadSnapshot().map((m) => [m.id, m]));
  return seed.models.map((s) => {
    const raw = snapshot.get(s.id);
    if (!raw) throw new Error(`Seed model ${s.id} is missing from data/openrouter-snapshot.json`);
    return {
      ...parseOpenRouterModel(raw),
      enabled: true,
      effortGain: 1,
      tps: s.tps,
      ttftMs: s.ttftMs,
      skills: priorSkills(s.intelligence, s.coding, seed.source.name, seed.source.trust, seed.source.fetchedAt),
      variantSkills: {},
      variantMetrics: {},
      updatedAt: seed.source.fetchedAt,
    };
  });
}
