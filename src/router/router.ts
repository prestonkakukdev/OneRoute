import { randomUUID } from 'node:crypto';
import { classifyHeuristically } from '../classifier/heuristic.js';
import { classifyWithJev } from '../classifier/jev.js';
import { buildJevState, extractFacts, latestUserText } from '../classifier/state.js';
import { config } from '../config.js';
import type { Store } from '../db/store.js';
import { chatCompletion } from '../providers/openrouter.js';
import { EFFORTS, type Effort, type TaskType } from '../taxonomy.js';
import type { Candidate, ChatRequest, Escalation, Preferences, RequestFacts, RouteDecision, RoutePrefs, TaskProfile } from '../types.js';
import { conservativePick, escalateWithLlm, escalationReasons } from './escalate.js';
import { requirementWeights } from './estimate.js';
import { rankCandidates, successValue } from './optimizer.js';

export interface RouterDeps {
  classify: (state: unknown) => Promise<TaskProfile>;
  llm: typeof chatCompletion;
}

const SHORTLIST_SIZE = 5;
const IMPLICIT_REJECT_THRESHOLD = 0.75;
const IMPLICIT_CONFIRM_THRESHOLD = 0.8;
const UNDERSPECIFIED_THRESHOLD = 0.8;

function asClarification(task: TaskProfile): TaskProfile {
  const level = (n: number, v: number) => ({
    value: v,
    probabilities: Object.fromEntries(Array.from({ length: n }, (_, i) => [i, i === v ? 1 : 0])) as Record<number, number>,
    confidence: 1,
  });
  return { ...task, difficulty: level(5, 1), reasoningDepth: level(4, 0), outputLength: level(4, 0) };
}

// Best effort level per model, in rank order. On a retry, the answer the user just rejected (same model at the
// same or a lower effort) is left out, so the escalation model cannot pick it again.
function shortlist(ranked: Candidate[], retry?: { modelId: string; effort: Effort }): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of ranked) {
    if (seen.has(c.modelId)) continue;
    if (retry && c.modelId === retry.modelId && EFFORTS.indexOf(c.effort as never) <= EFFORTS.indexOf(retry.effort as never)) continue;
    seen.add(c.modelId);
    out.push(c);
    if (out.length === SHORTLIST_SIZE) break;
  }
  return out;
}

export const DEFAULT_PREFERENCES: Preferences = {
  qualityWeight: 1,
  costWeight: 1,
  speedWeight: 1,
  openWeights: 'any',
  preferProviders: [],
  avoidProviders: [],
  minQuality: 0,
};

export function resolvePreferences(p?: Partial<Preferences>): Preferences {
  return { ...DEFAULT_PREFERENCES, ...(config.defaultPreferences as Partial<Preferences>), ...stripUndefined(p ?? {}) };
}

const stripUndefined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export function resolvePrefs(p: Partial<Omit<RoutePrefs, 'preferences'>> & { preferences?: Partial<Preferences> } | undefined): RoutePrefs {
  return {
    mode: p?.mode ?? config.defaultMode,
    preferences: resolvePreferences(p?.preferences),
    maxCostUsd: p?.maxCostUsd,
    maxLatencyS: p?.maxLatencyS,
    allowModels: p?.allowModels,
    denyModels: p?.denyModels,
    web: p?.web ?? 'auto',
    escalation: p?.escalation ?? 'auto',
    sessionId: p?.sessionId,
    sessionExplicit: p?.sessionExplicit ?? Boolean(p?.sessionId),
  };
}

const WEB_NEEDS_THRESHOLD = 0.6;
const WEB_RESEARCH_THRESHOLD = 0.5;

// Web search uses the same web-research weight the optimizer scores models with (task-type mix + Jev's
// importance, averaged over Jev's task-type probabilities), so choosing a model for its research ability
// and switching the search tool on can never disagree. Also on when the answer needs current information.
// Skipped when the client brings its own tools: an agent can search itself.
// A follow-up in a conversation that just used web search usually builds on those results ("explain number
// 4"), so it keeps search on unless Jev says current information is clearly irrelevant ("thanks!").
const WEB_FOLLOW_UP_THRESHOLD = 0.15;

export function webDecision(task: TaskProfile, facts: RequestFacts, prefs: RoutePrefs, recentWeb = false): { on: boolean; reason: string } {
  if (prefs.web === 'on') return { on: true, reason: 'your setting: always' };
  if (prefs.web === 'off') return { on: false, reason: 'your setting: never' };
  let research = 0;
  for (const [type, p] of Object.entries(task.taskType.probabilities) as [TaskType, number][]) {
    research += p * (requirementWeights(type, task, facts).web_research ?? 0);
  }
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const reasons = [
    task.needsWeb >= WEB_NEEDS_THRESHOLD ? `needs current info ${pct(task.needsWeb)}` : '',
    research >= WEB_RESEARCH_THRESHOLD ? `web research weight ${research.toFixed(2)}` : '',
    recentWeb && task.needsWeb >= WEB_FOLLOW_UP_THRESHOLD ? 'follow-up to a web-search answer' : '',
  ].filter(Boolean);
  if (facts.toolsPresent) return { on: false, reason: 'the client supplied its own tools' };
  if (reasons.length) return { on: true, reason: reasons.join(', ') };
  return { on: false, reason: `needs current info ${pct(task.needsWeb)}, web research weight ${research.toFixed(2)} (below 0.60 / 0.50)` };
}

export class Router {
  private readonly deps: RouterDeps;

  constructor(
    private readonly store: Store,
    deps: Partial<RouterDeps> = {},
  ) {
    this.deps = { classify: (s) => classifyWithJev(s), llm: chatCompletion, ...deps };
  }

  async route(req: ChatRequest, prefsIn?: Parameters<typeof resolvePrefs>[0]): Promise<RouteDecision> {
    const started = performance.now();
    const prefs = resolvePrefs(prefsIn);
    const facts = extractFacts(req);
    const text = latestUserText(req);

    // 1. Semantic judgment (Jev). Any failure degrades to the keyword fallback rather than failing the request.
    let task: TaskProfile;
    try {
      task = await this.deps.classify(buildJevState(req, facts));
    } catch (err) {
      task = classifyHeuristically(text, facts, (err as Error).message);
    }

    // A request that cannot be acted on needs a clarifying question, which any competent model can ask.
    // Not when tools are available: an agent can go and find the missing context itself.
    if ((task.underspecified ?? 0) >= UNDERSPECIFIED_THRESHOLD && !facts.toolsPresent) task = asClarification(task);

    // Feedback hidden in this message about the previous answer ("that's wrong" / "that worked"): recorded for
    // learning, and a rejected answer is retried with a stronger option instead of the same model.
    let retry: { modelId: string; effort: Effort } | undefined;
    let implicitFeedback: RouteDecision['implicitFeedback'];
    const previous = prefs.sessionId && facts.prefixTokens > 0 ? this.store.lastAnswered(prefs.sessionId) : undefined;
    if (previous) {
      const rejected = (task.previousRejected ?? 0) >= IMPLICIT_REJECT_THRESHOLD;
      const confirmed = !rejected && (task.previousConfirmed ?? 0) >= IMPLICIT_CONFIRM_THRESHOLD;
      if (rejected || confirmed) {
        const note = rejected ? `user said the answer was wrong: "${text.slice(0, 200)}"` : `user confirmed it worked: "${text.slice(0, 200)}"`;
        if (this.store.recordImplicitFeedback(previous.requestId, confirmed, note)) {
          implicitFeedback = { requestId: previous.requestId, modelId: previous.modelId, success: confirmed };
        }
      }
      if (rejected) {
        retry = { modelId: previous.modelId, effort: previous.effort };
        task = { ...task, highStakes: Math.max(task.highStakes, 0.8) };
      }
    }

    // 2. Deterministic optimization over the capability database.
    const models = this.store.listModels();
    const sticky = prefs.sessionId ? this.store.getSession(prefs.sessionId) : undefined;
    const web = webDecision(task, facts, prefs, sticky?.recentWeb ?? false);
    const useWeb = web.on;
    const { ranked, rejected } = rankCandidates({
      models,
      task,
      facts,
      prefs,
      useWeb,
      stickyModelId: retry ? undefined : sticky?.modelId,
      retry,
      learning: { stats: this.store.successStats(), priorStrength: config.priorStrength, exploration: config.exploration },
    });

    // 3. Escalate only when the decision is genuinely uncertain.
    let chosen = ranked[0]!;
    let escalation: Escalation | null = null;
    const reasons = prefs.escalation === 'off' ? [] : escalationReasons(task, ranked, successValue(task, facts, prefs));
    if (reasons.length) {
      const list = shortlist(ranked, retry);
      const t0 = performance.now();
      try {
        const pick = await escalateWithLlm(text, task, list, new Map(models.map((m) => [m.id, m])), reasons, this.deps.llm);
        chosen = list[pick.index]!;
        escalation = { reasons, by: 'llm', rationale: pick.rationale, latencyMs: performance.now() - t0 };
      } catch (err) {
        chosen = list[conservativePick(list)]!;
        escalation = {
          reasons,
          by: 'conservative',
          rationale: `escalation model unavailable (${(err as Error).message}); picked the highest-quality near-top option`,
          latencyMs: performance.now() - t0,
        };
      }
    }

    const decision: RouteDecision = {
      requestId: `rt_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      modelId: chosen.modelId,
      effort: chosen.effort,
      mode: prefs.mode,
      useWeb,
      task,
      facts,
      candidates: [chosen, ...ranked.filter((c) => c !== chosen)].slice(0, 12),
      escalation,
      sessionId: prefs.sessionId,
      sessionExplicit: prefs.sessionExplicit,
      stickyModel: sticky?.modelId,
      preferences: prefs.preferences,
      needs: requirementWeights(task.taskType.value, task, facts),
      webReason: web.reason,
      recentWeb: sticky?.recentWeb ?? false,
      implicitFeedback,
      rejected,
      routeMs: performance.now() - started,
    };
    this.store.recordDecision(decision, config.storePrompts ? text : '');
    return decision;
  }
}
