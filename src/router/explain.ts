import type { Preferences, RouteDecision } from '../types.js';
import { requirementWeights } from './estimate.js';

const pct = (p: number) => `${(p * 100).toFixed(0)}%`;
const money = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(3)}`);

function topEntries(d: Record<string | number, number>, n = 3): string {
  return Object.entries(d)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, p]) => `${k} ${pct(p)}`)
    .join(', ');
}

export function summaryLine(d: RouteDecision): string {
  const c = d.candidates[0]!;
  const parts = [
    `${d.modelId} (${d.effort})`,
    `${d.task.taskType.value} ${pct(d.task.taskType.confidence)} conf`,
    `difficulty ${d.task.difficulty.value}/4`,
    `est ${pct(c.pSuccess)} success, ${money(c.estCostUsd)}, ${c.estLatencyS.toFixed(1)}s`,
  ];
  if (d.useWeb) parts.push('web');
  if (d.escalation) parts.push(`escalated:${d.escalation.by}`);
  if (d.task.source !== 'jev') parts.push('heuristic classifier');
  return parts.join(' · ');
}

export function explainDecision(d: RouteDecision): string {
  const t = d.task;
  const lines = [
    `Request ${d.requestId} · mode ${d.mode} · routed in ${Math.round(d.routeMs)}ms (classifier ${t.source}, ${Math.round(t.latencyMs)}ms)`,
    d.preferences ? `  Preferences: ${describePreferences(d.preferences)}` : '',
    t.error ? `  Classifier error: ${t.error}` : '',
    '',
    'What the task needs',
    `  task type:        ${topEntries(t.taskType.probabilities)}  (confidence ${t.taskType.confidence.toFixed(2)})`,
    `  difficulty 0-4:   ${topEntries(t.difficulty.probabilities)}  (confidence ${t.difficulty.confidence.toFixed(2)})`,
    `  reasoning 0-3:    ${topEntries(t.reasoningDepth.probabilities)}`,
    `  output length 0-3: ${topEntries(t.outputLength.probabilities)}`,
    `  capabilities:     ${Object.entries(requirementWeights(t.taskType.value, t, d.facts))
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v.toFixed(2)}`)
      .join(', ')}`,
    `  needs web ${pct(t.needsWeb)} · latency-sensitive ${pct(t.latencySensitive)} · high stakes ${pct(t.highStakes)}`,
    `  input ~${d.facts.inputTokens} tokens${d.facts.hasImages ? ' · images' : ''}${d.facts.hasFiles ? ' · files' : ''}${d.facts.toolsPresent ? ' · tools' : ''}${d.facts.jsonSchemaRequired ? ' · json schema' : ''}`,
    '',
    'Top candidates (score = P(success) x value + quality premium - cost - latency penalty - preference penalty)',
    ...d.candidates.slice(0, 8).map((c, i) => {
      const name = `${c.modelId} (${c.effort})`.padEnd(44);
      return `  ${i === 0 ? '→' : ' '} ${name} P ${pct(c.pSuccess).padStart(4)}  ${money(c.estCostUsd).padStart(9)}  ${c.estLatencyS.toFixed(1).padStart(5)}s  score ${c.utility.toFixed(4)}`;
    }),
  ];
  if (d.stickyModel) lines.push('', `Session model: ${d.stickyModel} (its cached prefix makes it cheaper to stay on)`);
  if (d.escalation) {
    lines.push('', `Escalated (${d.escalation.by}): ${d.escalation.reasons.join('; ')}`);
    if (d.escalation.rationale) lines.push(`  ${d.escalation.rationale}`);
  }
  return lines.filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}

// Weights multiply how much each factor counts: <1 = matters less, >1 = matters more.
const weightWord = (w: number) => (w === 1 ? 'normal' : w < 1 ? `matters less (x${w})` : `matters more (x${w})`);

export function describePreferences(p: Preferences): string {
  const parts = [`answer quality ${weightWord(p.qualityWeight)}`, `saving money ${weightWord(p.costWeight)}`, `fast replies ${weightWord(p.speedWeight)}`];
  if (p.openWeights !== 'any') parts.push(`open weights: ${p.openWeights}`);
  if (p.preferProviders.length) parts.push(`prefer ${p.preferProviders.join('/')}`);
  if (p.avoidProviders.length) parts.push(`avoid ${p.avoidProviders.join('/')}`);
  if (p.minQuality) parts.push(`min quality ${p.minQuality}`);
  return parts.join(', ');
}

const short = (id: string) => id.split('/')[1] ?? id;
const usd = (v: number) => (Math.abs(v) < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`);

// Plain-English account of a decision: what Jev saw, what was ruled out, and why the winner beat the
// runner-up (the score component that differed most).
export function explainWhy(d: RouteDecision): string[] {
  const t = d.task;
  const out: string[] = [];
  const needs = Object.entries(d.needs ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k.replace(/_/g, ' '));
  out.push(
    `${t.source === 'jev' ? 'Jev' : 'The keyword fallback'} read this as ${t.taskType.value.replace(/_/g, ' ')} (${pct(t.taskType.confidence)} confident), difficulty ${t.difficulty.value}/4, needing mainly ${needs.join(', ') || 'general ability'}.`,
  );
  const signals = [
    t.latencySensitive >= 0.6 ? 'the user likely wants a fast reply' : '',
    t.highStakes >= 0.6 ? 'mistakes would be costly' : '',
    d.useWeb ? `web search is on (${d.webReason ?? 'needs live information'})` : '',
    (t.underspecified ?? 0) >= 0.8 ? 'it is too vague to act on, so it is treated as a request for clarification' : '',
  ].filter(Boolean);
  if (signals.length) out.push(`Signals: ${signals.join('; ')}.`);
  const rejected = Object.entries(d.rejected ?? {});
  if (rejected.length) {
    const reasons = [...new Set(rejected.map(([, r]) => r))].join(', ');
    out.push(`${rejected.length} model(s) ruled out before scoring (${reasons}).`);
  }
  const [win] = d.candidates;
  if (!win) return out;
  out.push(
    `Picked ${short(win.modelId)} at ${win.effort} effort: ~${pct(win.pSuccess)} chance of a good answer, ~${usd(win.estCostUsd)}, ~${win.estLatencyS.toFixed(1)}s.`,
  );
  const rival = d.candidates.find((c) => c.modelId !== win.modelId);
  if (rival?.breakdown && win.breakdown) {
    const diffs = (['value', 'quality', 'cost', 'latency', 'preference'] as const).map((k) => {
      const sign = k === 'value' || k === 'quality' ? 1 : -1;
      return { k, delta: sign * (win.breakdown![k] - rival.breakdown![k]) };
    });
    const helped = diffs.filter((x) => x.delta > 0).sort((a, b) => b.delta - a.delta)[0];
    const hurt = diffs.filter((x) => x.delta < 0).sort((a, b) => a.delta - b.delta)[0];
    const label: Record<string, string> = {
      value: 'a higher chance of success',
      quality: 'better answer quality',
      cost: 'lower cost',
      latency: 'faster response',
      preference: 'your preferences',
    };
    const against: Record<string, string> = {
      value: 'a lower chance of success',
      quality: 'slightly weaker answer quality',
      cost: 'a higher price',
      latency: 'a slower response',
      preference: 'your preferences',
    };
    out.push(
      `Beat ${short(rival.modelId)} (${rival.effort}; ${pct(rival.pSuccess)}, ${usd(rival.estCostUsd)}, ${rival.estLatencyS.toFixed(1)}s) mainly on ${label[helped?.k ?? 'value']}` +
        (hurt ? `, even though ${against[hurt.k]} counted against it.` : '.'),
    );
  }
  const sameModel = d.candidates.filter((c) => c.modelId === win.modelId && c.effort !== win.effort);
  const higher = sameModel.find((c) => c.estCostUsd > win.estCostUsd);
  if (higher) {
    out.push(
      `A higher effort (${higher.effort}) would raise success to ~${pct(higher.pSuccess)} for ${usd(higher.estCostUsd - win.estCostUsd)} more and ${(higher.estLatencyS - win.estLatencyS).toFixed(1)}s longer, which was not worth it here.`,
    );
  }
  if (d.implicitFeedback) {
    out.push(
      d.implicitFeedback.success
        ? `Your message confirms the previous answer (${short(d.implicitFeedback.modelId)}) worked; recorded as 👍 for learning.`
        : `Your message says the previous answer (${short(d.implicitFeedback.modelId)}) was wrong; recorded as 👎 for learning, and this retry avoids repeating it at the same effort.`,
    );
  }
  if (d.stickyModel && d.implicitFeedback?.success !== false) out.push(`This conversation was on ${short(d.stickyModel)}; staying on it is cheaper because its cached history can be reused.`);
  if (d.escalation) out.push(`Escalated (${d.escalation.by}): ${d.escalation.reasons.join('; ')}. ${d.escalation.rationale ?? ''}`);
  return out;
}
