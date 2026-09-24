import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MODES, type Mode } from './taxonomy.js';

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function mode(raw: string | undefined): Mode {
  return MODES.includes(raw as Mode) ? (raw as Mode) : 'balanced';
}

// Optional user defaults (e.g. preferences) in ./mrouter.config.json; request options override them.
function loadUserConfig(): { mode?: string; preferences?: Record<string, unknown> } {
  const file = resolve(process.cwd(), 'mrouter.config.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid mrouter.config.json: ${(err as Error).message}`);
  }
}
const userConfig = loadUserConfig();

export const config = {
  openRouterKey: process.env.OPENROUTER_API_KEY ?? '',
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
  aaKey: process.env.ARTIFICIAL_ANALYSIS_API_KEY ?? '',
  aaBaseUrl: process.env.ARTIFICIAL_ANALYSIS_BASE_URL ?? 'https://artificialanalysis.ai/api/v2',
  profileModel: process.env.ROUTER_PROFILE_MODEL ?? 'anthropic/claude-opus-5.5',
  typesafeKey: process.env.TYPESAFE_API_KEY ?? '',
  typesafeBaseUrl: process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai/v1',
  jevModel: process.env.ROUTER_JEV_MODEL ?? 'jev-latest',
  // Jev usually answers in 0.25-1.2s; the budget covers cold starts before falling back to keywords.
  jevTimeoutMs: num('ROUTER_JEV_TIMEOUT_MS', 6000),
  dbPath: process.env.ROUTER_DB_PATH ?? resolve(process.cwd(), 'router.db'),
  defaultMode: mode(process.env.ROUTER_DEFAULT_MODE ?? userConfig.mode),
  defaultPreferences: userConfig.preferences ?? {},
  port: num('ROUTER_PORT', 8787),
  gatewayKey: process.env.ROUTER_API_KEY ?? '',
  escalationModel: process.env.ROUTER_ESCALATION_MODEL ?? 'google/gemini-3.8-flash',
  exploration: process.env.ROUTER_EXPLORATION === 'thompson' ? 'thompson' : 'off',
  // Escalate when Jev is unsure what kind of task this is...
  minTaskConfidence: num('ROUTER_MIN_TASK_CONFIDENCE', 0.45),
  minDifficultyConfidence: num('ROUTER_MIN_DIFFICULTY_CONFIDENCE', 0.3),
  // ...or when the top two candidates are within this fraction of the success value.
  tieMargin: num('ROUTER_TIE_MARGIN', 0.03),
  // Learned success rates are blended with the prior as if the prior were this many observations.
  priorStrength: num('ROUTER_PRIOR_STRENGTH', 10),
  maxFallbacks: num('ROUTER_MAX_FALLBACKS', 2),
  // Store the first 500 characters of each prompt with its routing decision (useful for tuning).
  storePrompts: process.env.ROUTER_STORE_PROMPTS !== 'false',
  // Prompt-cache lifetime for conversations on explicit-cache providers (Anthropic). People often pause
  // longer than 5 minutes between messages, so conversations default to the 1-hour cache.
  sessionCacheTtl: process.env.ROUTER_CACHE_TTL === '5m' ? '5m' : '1h',
} as const;

export type Config = typeof config;
