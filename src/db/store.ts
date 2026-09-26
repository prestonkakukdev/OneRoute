import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import type { Dimension, Effort } from '../taxonomy.js';
import type { ProviderStats } from '../ingest/providerStats.js';
import type { ModelRecord, RouteDecision, SkillValue, VariantMetrics } from '../types.js';
import { catalogIsNewer, getMeta, importCatalog, readCatalog, setMeta } from './catalog.js';
import { buildSeedModels } from './seed.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  context_length INTEGER NOT NULL,
  max_output INTEGER NOT NULL,
  input_modalities TEXT NOT NULL,
  supported_params TEXT NOT NULL,
  pricing TEXT NOT NULL,
  efforts TEXT NOT NULL,
  reasoning_mandatory INTEGER NOT NULL,
  default_effort TEXT NOT NULL,
  effort_gain REAL NOT NULL DEFAULT 1,
  tps REAL NOT NULL,
  ttft_ms REAL NOT NULL,
  perf_samples INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  updated_at TEXT NOT NULL
);
-- effort '*' = skill at the model's top effort (the effort curve derives lower levels);
-- any other effort = a measured value for exactly that variant, which wins over the curve.
CREATE TABLE IF NOT EXISTS skills (
  model_id TEXT NOT NULL,
  effort TEXT NOT NULL,
  task_type TEXT NOT NULL,
  skill REAL NOT NULL,
  source TEXT NOT NULL,
  trust REAL NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (model_id, effort, task_type)
);
-- Step 1 raw data: every benchmark number for every model x effort, with provenance.
CREATE TABLE IF NOT EXISTS benchmark_results (
  model_id TEXT NOT NULL,
  effort TEXT NOT NULL,
  benchmark TEXT NOT NULL,
  value REAL NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  independent INTEGER NOT NULL,
  measured_at TEXT NOT NULL,
  PRIMARY KEY (model_id, effort, benchmark, source)
);
CREATE TABLE IF NOT EXISTS variant_metrics (
  model_id TEXT NOT NULL,
  effort TEXT NOT NULL,
  tps REAL,
  ttft_s REAL,
  reasoning_tokens_ref REAL,
  source TEXT NOT NULL,
  measured_at TEXT NOT NULL,
  PRIMARY KEY (model_id, effort)
);
-- Live production speed/reliability per model (OpenRouter provider stats).
CREATE TABLE IF NOT EXISTS provider_stats (
  model_id TEXT PRIMARY KEY,
  tps REAL NOT NULL,
  latency_s REAL NOT NULL,
  uptime REAL NOT NULL,
  providers INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  measured_at TEXT NOT NULL
);
-- Step 3: LLM-written profile, regenerated only when the model's data hash changes.
CREATE TABLE IF NOT EXISTS profiles (
  model_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  data_hash TEXT NOT NULL,
  generator TEXT NOT NULL,
  generated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  request_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  session_id TEXT,
  mode TEXT NOT NULL,
  model_id TEXT NOT NULL,
  effort TEXT NOT NULL,
  task_type TEXT NOT NULL,
  difficulty INTEGER NOT NULL,
  task TEXT NOT NULL,
  facts TEXT NOT NULL,
  candidates TEXT NOT NULL,
  escalation TEXT,
  query_excerpt TEXT,
  route_ms REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS outcomes (
  request_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  effort TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  latency_ms REAL,
  ttft_ms REAL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  reasoning_tokens INTEGER,
  cost_usd REAL,
  success INTEGER,
  feedback_score REAL,
  feedback_comment TEXT,
  feedback_at TEXT,
  created_at TEXT NOT NULL
);
-- Learned correction factors for the estimator: running sum of log(actual / estimated) per model
-- (and effort for reasoning); applied as exp(sum / (n + prior)) so few samples barely move it.
CREATE TABLE IF NOT EXISTS calibration (
  model_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  effort TEXT NOT NULL,
  sum_log REAL NOT NULL,
  n INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (model_id, metric, effort)
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  effort TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Saved conversations from the app. A chat's id is also its routing session id.
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_turns (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data TEXT NOT NULL, -- the app's turn: prompt, attachments, routing decision, answer, feedback
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, turn_id)
);
CREATE INDEX IF NOT EXISTS chats_updated ON chats(updated_at);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
}

export interface OutcomeInput {
  requestId: string;
  modelId: string;
  effort: Effort;
  status: 'ok' | 'error';
  error?: string;
  latencyMs?: number;
  ttftMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  fallbacks?: number;
  cachedTokens?: number; // prompt tokens read from the provider's prompt cache
  cacheWriteTokens?: number;
  provider?: string; // upstream provider that served the request
}

export interface SuccessStat {
  successes: number;
  trials: number;
}

export const statKey = (modelId: string, taskType: string, difficulty: number) => `${modelId}|${taskType}|${difficulty}`;

const now = () => new Date().toISOString();

// Feedback inferred from the next message is less certain than an explicit rating.
export const IMPLICIT_FEEDBACK_WEIGHT = 0.5;

// Calibration factors are shrunk toward 1 as if there were this many neutral observations.
export const CALIBRATION_PRIOR = 5;

// A session stays on its model only while that model's prompt cache is likely still warm.
const SESSION_TTL_MS = (config.sessionCacheTtl === '1h' ? 55 : 5) * 60 * 1000;

export class Store {
  readonly db: DatabaseSync;
  // Routing reads the whole catalog on every request; it is cached and dropped whenever this connection
  // writes catalog data or another process (e.g. `s1route ingest`) commits (PRAGMA data_version changes).
  private catalogCache: { version: number; all: ModelRecord[] } | undefined;
  private statsCache: { version: number; stats: Map<string, SuccessStat> } | undefined;

  // The shipped model catalog (data/catalog.json) is loaded into a new database and whenever a newer one
  // arrives (git pull). In-memory stores (tests) use the small built-in seed unless asked otherwise.
  constructor(path: string, opts: { catalog?: boolean } = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    const cols = (this.db.prepare('PRAGMA table_info(outcomes)').all() as Row[]).map((c) => c.name);
    if (!cols.includes('fallbacks')) this.db.exec('ALTER TABLE outcomes ADD COLUMN fallbacks INTEGER');
    for (const [col, type] of [['cached_tokens', 'INTEGER'], ['cache_write_tokens', 'INTEGER'], ['provider', 'TEXT'], ['feedback_source', 'TEXT']] as const) {
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE outcomes ADD COLUMN ${col} ${type}`);
    }
    // Ratings recorded before feedback_source existed were all given by the user (implicit feedback always sets it).
    this.db.exec(`UPDATE outcomes SET feedback_source = 'user' WHERE feedback_source IS NULL AND feedback_at IS NOT NULL`);
    const decisionCols = (this.db.prepare('PRAGMA table_info(decisions)').all() as Row[]).map((c) => c.name);
    if (!decisionCols.includes('use_web')) this.db.exec('ALTER TABLE decisions ADD COLUMN use_web INTEGER');
    const sessionCols = (this.db.prepare('PRAGMA table_info(sessions)').all() as Row[]).map((c) => c.name);
    if (!sessionCols.includes('web_at')) this.db.exec('ALTER TABLE sessions ADD COLUMN web_at TEXT');
    const modelCols = (this.db.prepare('PRAGMA table_info(models)').all() as Row[]).map((c) => c.name);
    if (!modelCols.includes('open_weights')) this.db.exec('ALTER TABLE models ADD COLUMN open_weights INTEGER NOT NULL DEFAULT 0');
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number };
    const catalog = (opts.catalog ?? path !== ':memory:') ? readCatalog() : undefined;
    if (catalog && (n === 0 || catalogIsNewer(this.db, catalog))) importCatalog(this.db, catalog);
    else if (n === 0) this.seed(buildSeedModels());
  }

  getMeta(key: string): string | undefined {
    return getMeta(this.db, key);
  }

  setMeta(key: string, value: string): void {
    setMeta(this.db, key, value);
  }

  seed(models: ModelRecord[]): void {
    this.db.exec('BEGIN');
    try {
      for (const m of models) {
        this.upsertModel(m);
        for (const [task, v] of Object.entries(m.skills)) this.upsertSkill(m.id, '*', task as Dimension, v!);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  upsertModel(m: Omit<ModelRecord, 'skills' | 'variantSkills' | 'variantMetrics'>): void {
    this.invalidate();
    this.db
      .prepare(
        `INSERT INTO models (id, name, provider, enabled, context_length, max_output, input_modalities, supported_params,
           pricing, efforts, reasoning_mandatory, default_effort, effort_gain, tps, ttft_ms, notes, updated_at, open_weights)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, provider = excluded.provider, context_length = excluded.context_length,
           open_weights = excluded.open_weights,
           max_output = excluded.max_output, input_modalities = excluded.input_modalities,
           supported_params = excluded.supported_params, pricing = excluded.pricing, efforts = excluded.efforts,
           reasoning_mandatory = excluded.reasoning_mandatory, default_effort = excluded.default_effort,
           updated_at = excluded.updated_at`,
      )
      .run(
        m.id,
        m.name,
        m.provider,
        m.enabled ? 1 : 0,
        m.contextLength,
        m.maxOutput,
        JSON.stringify(m.inputModalities),
        JSON.stringify(m.supportedParams),
        JSON.stringify(m.pricing),
        JSON.stringify(m.efforts),
        m.reasoningMandatory ? 1 : 0,
        m.defaultEffort,
        m.effortGain,
        m.tps,
        m.ttftMs,
        m.notes ?? null,
        m.updatedAt,
        m.openWeights ? 1 : 0,
      );
  }

  upsertSkill(modelId: string, effort: Effort | '*', task: Dimension, v: SkillValue): void {
    this.invalidate();
    this.db
      .prepare(
        `INSERT INTO skills (model_id, effort, task_type, skill, source, trust, samples, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(model_id, effort, task_type) DO UPDATE SET
           skill = excluded.skill, source = excluded.source, trust = excluded.trust,
           samples = excluded.samples, updated_at = excluded.updated_at`,
      )
      .run(modelId, effort, task, v.skill, v.source, v.trust, v.samples, v.updatedAt);
  }

  replaceSkills(modelId: string, rows: { effort: Effort | '*'; dimension: Dimension; value: SkillValue }[]): void {
    this.invalidate();
    this.db.prepare('DELETE FROM skills WHERE model_id = ?').run(modelId);
    for (const r of rows) this.upsertSkill(modelId, r.effort, r.dimension, r.value);
  }

  replaceAllBenchmarks(
    modelId: string,
    rows: { effort: Effort; benchmark: string; value: number; source: string; sourceRef?: string; independent: boolean; measuredAt: string }[],
  ): void {
    this.db.prepare('DELETE FROM benchmark_results WHERE model_id = ?').run(modelId);
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO benchmark_results (model_id, effort, benchmark, value, source, source_ref, independent, measured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) stmt.run(modelId, r.effort, r.benchmark, r.value, r.source, r.sourceRef ?? null, r.independent ? 1 : 0, r.measuredAt);
  }

  setProviderStats(modelId: string, s: ProviderStats): void {
    this.invalidate();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO provider_stats (model_id, tps, latency_s, uptime, providers, requests, measured_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(modelId, s.tps, s.latencyS, s.uptime, s.providers, s.requests, s.measuredAt);
  }

  replaceVariantMetrics(modelId: string, rows: { effort: Effort; metrics: VariantMetrics }[]): void {
    this.invalidate();
    this.db.prepare('DELETE FROM variant_metrics WHERE model_id = ?').run(modelId);
    const stmt = this.db.prepare(
      `INSERT INTO variant_metrics (model_id, effort, tps, ttft_s, reasoning_tokens_ref, source, measured_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const { effort, metrics: m } of rows) {
      stmt.run(modelId, effort, m.tps ?? null, m.ttftS ?? null, m.reasoningTokensRef ?? null, m.source, m.measuredAt);
    }
  }

  setPerformance(modelId: string, tps: number, ttftMs: number): void {
    this.invalidate();
    this.db.prepare('UPDATE models SET tps = ?, ttft_ms = ? WHERE id = ?').run(tps, ttftMs, modelId);
  }

  benchmarks(modelId: string): { effort: Effort; benchmark: string; value: number; source: string; measured_at: string }[] {
    return this.db
      .prepare('SELECT effort, benchmark, value, source, measured_at FROM benchmark_results WHERE model_id = ? ORDER BY effort, benchmark')
      .all(modelId) as never;
  }

  getProfile(modelId: string): { text: string; dataHash: string } | undefined {
    const row = this.db.prepare('SELECT text, data_hash FROM profiles WHERE model_id = ?').get(modelId) as Row | undefined;
    return row ? { text: row.text as string, dataHash: row.data_hash as string } : undefined;
  }

  setProfile(modelId: string, text: string, dataHash: string, generator: string): void {
    this.invalidate();
    this.db
      .prepare(
        `INSERT INTO profiles (model_id, text, data_hash, generator, generated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(model_id) DO UPDATE SET text = excluded.text, data_hash = excluded.data_hash,
           generator = excluded.generator, generated_at = excluded.generated_at`,
      )
      .run(modelId, text, dataHash, generator, now());
  }

  setEnabled(modelId: string, enabled: boolean): boolean {
    this.invalidate();
    return this.db.prepare('UPDATE models SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, modelId).changes > 0;
  }

  private dataVersion(): number {
    return (this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
  }

  private invalidate(): void {
    this.catalogCache = undefined;
    this.statsCache = undefined;
  }

  listModels(opts: { includeDisabled?: boolean } = {}): ModelRecord[] {
    const version = this.dataVersion();
    if (this.catalogCache?.version !== version) this.catalogCache = { version, all: this.loadModels() };
    return opts.includeDisabled ? this.catalogCache.all : this.catalogCache.all.filter((m) => m.enabled);
  }

  private loadModels(): ModelRecord[] {
    const rows = this.db.prepare('SELECT * FROM models ORDER BY id').all() as Row[];
    const skillRows = this.db.prepare('SELECT * FROM skills').all() as Row[];
    const metricRows = this.db.prepare('SELECT * FROM variant_metrics').all() as Row[];
    const statRows = new Map((this.db.prepare('SELECT * FROM provider_stats').all() as Row[]).map((p) => [p.model_id as string, p]));
    const calib = new Map<string, NonNullable<ModelRecord['calibration']>>();
    for (const c of this.calibrationRows()) {
      const entry = calib.get(c.model_id) ?? { reasoning: {}, samples: 0 };
      const factor = Math.exp(c.sum_log / (c.n + CALIBRATION_PRIOR));
      if (c.metric === 'output' && c.effort === '*') {
        entry.output = factor;
        entry.samples = Math.max(entry.samples, c.n);
      } else if (c.metric === 'output') (entry.outputByLength ??= {})[c.effort] = factor;
      else if (c.metric === 'input') entry.input = factor;
      else if (c.metric === 'latency') entry.latency = factor;
      else if (c.metric === 'web') entry.web = factor;
      else if (c.metric === 'reasoning') entry.reasoning[c.effort as Effort | '*'] = factor;
      calib.set(c.model_id, entry);
    }
    const profileRows = new Map(
      (this.db.prepare('SELECT model_id, text FROM profiles').all() as Row[]).map((p) => [p.model_id as string, p.text as string]),
    );
    const byModel = new Map<string, Row[]>();
    for (const s of skillRows) {
      const list = byModel.get(s.model_id as string) ?? [];
      list.push(s);
      byModel.set(s.model_id as string, list);
    }
    return rows.map((r) => {
      const skills: ModelRecord['skills'] = {};
      const variantSkills: ModelRecord['variantSkills'] = {};
      for (const s of byModel.get(r.id as string) ?? []) {
        const v: SkillValue = {
          skill: s.skill as number,
          source: s.source as string,
          trust: s.trust as number,
          samples: s.samples as number,
          updatedAt: s.updated_at as string,
        };
        const task = s.task_type as Dimension;
        if (s.effort === '*') skills[task] = v;
        else (variantSkills[s.effort as Effort] ??= {})[task] = v;
      }
      const variantMetrics: ModelRecord['variantMetrics'] = {};
      for (const m of metricRows.filter((x) => x.model_id === r.id)) {
        variantMetrics[m.effort as Effort] = {
          tps: (m.tps as number | null) ?? undefined,
          ttftS: (m.ttft_s as number | null) ?? undefined,
          reasoningTokensRef: (m.reasoning_tokens_ref as number | null) ?? undefined,
          source: m.source as string,
          measuredAt: m.measured_at as string,
        };
      }
      return {
        id: r.id as string,
        name: r.name as string,
        provider: r.provider as string,
        openWeights: r.open_weights === 1,
        enabled: r.enabled === 1,
        contextLength: r.context_length as number,
        maxOutput: r.max_output as number,
        inputModalities: JSON.parse(r.input_modalities as string),
        supportedParams: JSON.parse(r.supported_params as string),
        pricing: JSON.parse(r.pricing as string),
        efforts: JSON.parse(r.efforts as string),
        reasoningMandatory: r.reasoning_mandatory === 1,
        defaultEffort: r.default_effort as Effort,
        effortGain: r.effort_gain as number,
        tps: r.tps as number,
        ttftMs: r.ttft_ms as number,
        skills,
        variantSkills,
        variantMetrics,
        profile: profileRows.get(r.id as string),
        // Web-search size is mostly a property of the search, so models without their own data use the
        // average across all models ('*').
        calibration: (() => {
          const own = calib.get(r.id as string);
          const web = own?.web ?? calib.get('*')?.web;
          return own || web !== undefined ? { reasoning: {}, samples: 0, ...own, web } : undefined;
        })(),
        providerStats: (() => {
          const p = statRows.get(r.id as string);
          return p
            ? {
                tps: p.tps as number,
                latencyS: p.latency_s as number,
                uptime: p.uptime as number,
                providers: p.providers as number,
                requests: p.requests as number,
                measuredAt: p.measured_at as string,
              }
            : undefined;
        })(),
        notes: (r.notes as string | null) ?? undefined,
        updatedAt: r.updated_at as string,
      };
    });
  }

  recordDecision(d: RouteDecision, queryExcerpt: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO decisions (request_id, created_at, session_id, mode, model_id, effort, task_type,
           difficulty, task, facts, candidates, escalation, query_excerpt, route_ms, use_web)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.requestId,
        now(),
        d.sessionId ?? null,
        d.mode,
        d.modelId,
        d.effort,
        d.task.taskType.value,
        d.task.difficulty.value,
        JSON.stringify(d.task),
        JSON.stringify(d.facts),
        JSON.stringify(d.candidates.slice(0, 8)),
        d.escalation ? JSON.stringify(d.escalation) : null,
        queryExcerpt.slice(0, 500),
        d.routeMs,
        d.useWeb ? 1 : 0,
      );
  }

  recordOutcome(o: OutcomeInput): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO outcomes (request_id, model_id, effort, status, error, latency_ms, ttft_ms,
           prompt_tokens, completion_tokens, reasoning_tokens, cost_usd, fallbacks, cached_tokens, cache_write_tokens, provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.requestId,
        o.modelId,
        o.effort,
        o.status,
        o.error ?? null,
        o.latencyMs ?? null,
        o.ttftMs ?? null,
        o.promptTokens ?? null,
        o.completionTokens ?? null,
        o.reasoningTokens ?? null,
        o.costUsd ?? null,
        o.fallbacks ?? 0,
        o.cachedTokens ?? null,
        o.cacheWriteTokens ?? null,
        o.provider ?? null,
        now(),
      );
  }

  // Returns false when the request id is unknown.
  recordFeedback(requestId: string, success: boolean, score?: number, comment?: string): boolean {
    this.statsCache = undefined;
    const res = this.db
      .prepare(
        `UPDATE outcomes SET success = ?, feedback_score = ?, feedback_comment = ?, feedback_at = ?, feedback_source = 'user'
         WHERE request_id = ?`,
      )
      .run(success ? 1 : 0, score ?? null, comment ?? null, now(), requestId);
    return res.changes > 0;
  }

  // Feedback inferred from the user's next message; never overrides a rating the user gave themselves.
  recordImplicitFeedback(requestId: string, success: boolean, comment: string): boolean {
    this.statsCache = undefined;
    const res = this.db
      .prepare(
        `UPDATE outcomes SET success = ?, feedback_comment = ?, feedback_at = ?, feedback_source = 'implicit'
         WHERE request_id = ? AND status = 'ok' AND (feedback_source IS NULL OR feedback_source = 'implicit')`,
      )
      .run(success ? 1 : 0, comment, now(), requestId);
    return res.changes > 0;
  }

  // The most recent answered request of a conversation (the "previous answer" of the next turn).
  lastAnswered(sessionId: string): { requestId: string; modelId: string; effort: Effort } | undefined {
    const row = this.db
      .prepare(
        `SELECT o.request_id, o.model_id, o.effort FROM outcomes o JOIN decisions d ON d.request_id = o.request_id
         WHERE d.session_id = ? AND o.status = 'ok' ORDER BY d.created_at DESC LIMIT 1`,
      )
      .get(sessionId) as Row | undefined;
    return row ? { requestId: row.request_id as string, modelId: row.model_id as string, effort: row.effort as Effort } : undefined;
  }

  addCalibration(modelId: string, metric: string, effort: string, ratio: number): void {
    this.invalidate();
    this.db
      .prepare(
        `INSERT INTO calibration (model_id, metric, effort, sum_log, n, updated_at) VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(model_id, metric, effort) DO UPDATE SET sum_log = sum_log + excluded.sum_log, n = n + 1, updated_at = excluded.updated_at`,
      )
      .run(modelId, metric, effort, Math.log(ratio), now());
  }

  resetCalibration(): void {
    this.invalidate();
    this.db.exec('DELETE FROM calibration');
  }

  calibrationRows(): { model_id: string; metric: string; effort: string; sum_log: number; n: number }[] {
    return this.db.prepare('SELECT model_id, metric, effort, sum_log, n FROM calibration ORDER BY model_id, metric, effort').all() as never;
  }

  // Exponential moving average of measured speed, so the latency model tracks reality.
  updatePerformance(modelId: string, ttftMs: number | undefined, tps: number | undefined): void {
    this.invalidate();
    const alpha = 0.2;
    if (ttftMs !== undefined && ttftMs > 0) {
      this.db.prepare('UPDATE models SET ttft_ms = ttft_ms * ? + ? * ? WHERE id = ?').run(1 - alpha, alpha, ttftMs, modelId);
    }
    if (tps !== undefined && tps > 0 && Number.isFinite(tps)) {
      this.db.prepare('UPDATE models SET tps = tps * ? + ? * ? WHERE id = ?').run(1 - alpha, alpha, tps, modelId);
    }
    this.db.prepare('UPDATE models SET perf_samples = perf_samples + 1 WHERE id = ?').run(modelId);
  }

  // Observed success counts per (served model, task type, difficulty) from explicit feedback.
  // Provider errors are availability problems, not quality signals, so they are not counted.
  successStats(): Map<string, SuccessStat> {
    const version = this.dataVersion();
    if (this.statsCache?.version === version) return this.statsCache.stats;
    const rows = this.db
      .prepare(
        `SELECT o.model_id AS model_id, d.task_type AS task_type, d.difficulty AS difficulty,
                SUM(CASE WHEN o.success = 1 THEN w ELSE 0 END) AS successes, SUM(w) AS trials
         FROM (SELECT *, CASE feedback_source WHEN 'implicit' THEN ${IMPLICIT_FEEDBACK_WEIGHT} ELSE 1.0 END AS w FROM outcomes) o
         JOIN decisions d ON d.request_id = o.request_id
         WHERE o.success IS NOT NULL
         GROUP BY o.model_id, d.task_type, d.difficulty`,
      )
      .all() as Row[];
    const out = new Map<string, SuccessStat>();
    for (const r of rows) {
      out.set(statKey(r.model_id as string, r.task_type as string, r.difficulty as number), {
        successes: r.successes as number,
        trials: r.trials as number,
      });
    }
    this.statsCache = { version, stats: out };
    return out;
  }

  // recentWeb: an earlier turn of this conversation used live web search (within the session lifetime).
  getSession(sessionId: string): { modelId: string; effort: Effort; recentWeb: boolean } | undefined {
    const row = this.db.prepare('SELECT model_id, effort, updated_at, web_at FROM sessions WHERE session_id = ?').get(sessionId) as
      | Row
      | undefined;
    if (!row || Date.now() - Date.parse(row.updated_at as string) > SESSION_TTL_MS) return undefined;
    const webAt = row.web_at ? Date.parse(row.web_at as string) : NaN;
    return { modelId: row.model_id as string, effort: row.effort as Effort, recentWeb: Date.now() - webAt <= SESSION_TTL_MS };
  }

  setSession(sessionId: string, modelId: string, effort: Effort, usedWeb = false): void {
    const at = now();
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, model_id, effort, updated_at, web_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET model_id = excluded.model_id, effort = excluded.effort,
           updated_at = excluded.updated_at, web_at = COALESCE(excluded.web_at, sessions.web_at)`,
      )
      .run(sessionId, modelId, effort, at, usedWeb ? at : null);
  }

  // --- Saved chats (the app's conversation history) ---------------------------------------------

  listChats(limit = 200): ChatSummary[] {
    return (
      this.db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at, (SELECT COUNT(*) FROM chat_turns t WHERE t.chat_id = c.id) AS turns
           FROM chats c ORDER BY c.updated_at DESC LIMIT ?`,
        )
        .all(limit) as Row[]
    ).map((r) => ({ id: r.id as string, title: r.title as string, createdAt: r.created_at as string, updatedAt: r.updated_at as string, turns: r.turns as number }));
  }

  getChat(id: string): { id: string; title: string; createdAt: string; updatedAt: string; turns: unknown[] } | undefined {
    const chat = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as Row | undefined;
    if (!chat) return undefined;
    const turns = (this.db.prepare('SELECT data FROM chat_turns WHERE chat_id = ? ORDER BY idx').all(id) as Row[]).map((r) => JSON.parse(r.data as string));
    return { id, title: chat.title as string, createdAt: chat.created_at as string, updatedAt: chat.updated_at as string, turns };
  }

  // Creates the chat on its first turn (titled from that turn); later saves of the same turn replace it in place.
  saveChatTurn(chatId: string, turnId: string, turn: unknown, title: string): void {
    const at = now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at')
        .run(chatId, title.trim().slice(0, 120) || 'New chat', at, at);
      this.db
        .prepare(
          `INSERT INTO chat_turns (chat_id, turn_id, idx, data, updated_at)
           VALUES (?, ?, (SELECT COUNT(*) FROM chat_turns WHERE chat_id = ?), ?, ?)
           ON CONFLICT(chat_id, turn_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        )
        .run(chatId, turnId, chatId, JSON.stringify(turn), at);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  renameChat(id: string, title: string): boolean {
    return this.db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title.trim().slice(0, 120), id).changes > 0;
  }

  deleteChat(id: string): boolean {
    this.db.prepare('DELETE FROM chat_turns WHERE chat_id = ?').run(id);
    return this.db.prepare('DELETE FROM chats WHERE id = ?').run(id).changes > 0;
  }

  summary(): Row[] {
    return this.db
      .prepare(
        `SELECT o.model_id AS model, COUNT(*) AS requests,
                ROUND(SUM(COALESCE(o.cost_usd, 0)), 4) AS cost_usd,
                ROUND(AVG(o.latency_ms)) AS avg_latency_ms,
                SUM(CASE WHEN o.status = 'error' THEN 1 ELSE 0 END) AS errors,
                SUM(CASE WHEN o.success = 1 AND o.feedback_source = 'user' THEN 1 ELSE 0 END) AS good,
                SUM(CASE WHEN o.success = 0 AND o.feedback_source = 'user' THEN 1 ELSE 0 END) AS bad,
                SUM(CASE WHEN o.success = 1 AND o.feedback_source = 'implicit' THEN 1 ELSE 0 END) AS inferred_good,
                SUM(CASE WHEN o.success = 0 AND o.feedback_source = 'implicit' THEN 1 ELSE 0 END) AS inferred_bad
         FROM outcomes o GROUP BY o.model_id ORDER BY requests DESC`,
      )
      .all() as Row[];
  }

  close(): void {
    this.db.close();
  }
}
