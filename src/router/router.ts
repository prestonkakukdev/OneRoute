import { randomUUID } from 'node:crypto';
import { classifyHeuristically } from '../classifier/heuristic.js';
import { classifyWithJev } from '../classifier/jev.js';
import { buildJevState, extractFacts, latestUserText } from '../classifier/state.js';
import { config } from '../config.js';
import type { Store } from '../db/store.js';
import { chatCompletion } from '../providers/openrouter.js';
import type { Candidate, ChatRequest, Escalation, Preferences, RouteDecision, RoutePrefs, TaskProfile } from '../types.js';
import { conservativePick, escalateWithLlm, escalationReasons } from './escalate.js';
import { requirementWeights } from './estimate.js';
import { rankCandidates, successValue } from './optimizer.js';

export interface RouterDeps {
  classify: (state: unknown) => Promise<TaskProfile>;
  llm: typeof chatCompletion;
}

const SHORTLIST_SIZE = 5;
const UNDERSPECIFIED_THRESHOLD = 0.8;

function asClarification(task: TaskProfile): TaskProfile {
  const level = (n: number, v: number) => ({
    value: v,
    probabilities: Object.fromEntries(Array.from({ length: n }, (_, i) => [i, i === v ? 1 : 0])) as Record<number, number>,
    confidence: 1,
  });
  return { ...task, difficulty: level(5, 1), reasoningDepth: level(4, 0), outputLength: level(4, 0) };
}

// Best effort level per model, in rank order.
function shortlist(ranked: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of ranked) {
    if (seen.has(c.modelId)) continue;
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
  };
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

    // 2. Deterministic optimization over the capability database.
    const models = this.store.listModels();
    const sticky = prefs.sessionId ? this.store.getSession(prefs.sessionId) : undefined;
    // Auto web search when Jev says the answer needs current information, or the request is clearly a research
    // task (e.g. "research the effects of X" benefits from current sources even if the topic is not news).
    // Skipped when the client brings its own tools: an agent can search itself.
    const wantsWeb =
      task.needsWeb >= 0.6 || (task.capabilities.web_research ?? 0) >= 0.5 || (task.taskType.probabilities.research ?? 0) >= 0.6;
    const useWeb = prefs.web === 'on' || (prefs.web === 'auto' && wantsWeb && !facts.toolsPresent);
    const { ranked, rejected } = rankCandidates({
      models,
      task,
      facts,
      prefs,
      useWeb,
      stickyModelId: sticky?.modelId,
      learning: { stats: this.store.successStats(), priorStrength: config.priorStrength, exploration: config.exploration },
    });

    // 3. Escalate only when the decision is genuinely uncertain.
    let chosen = ranked[0]!;
    let escalation: Escalation | null = null;
    const reasons = prefs.escalation === 'off' ? [] : escalationReasons(task, ranked, successValue(task, facts, prefs));
    if (reasons.length) {
      const list = shortlist(ranked);
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
      stickyModel: sticky?.modelId,
      preferences: prefs.preferences,
      needs: requirementWeights(task.taskType.value, task, facts),
      rejected,
      routeMs: performance.now() - started,
    };
    this.store.recordDecision(decision, config.storePrompts ? text : '');
    return decision;
  }
}
