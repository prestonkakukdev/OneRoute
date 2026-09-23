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
    `  input ~${d.facts.inputTokens} tokens${d.facts.hasImages ? ' · images' : ''}${d.facts.toolsPresent ? ' · tools' : ''}${d.facts.jsonSchemaRequired ? ' · json schema' : ''}`,
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

export function describePreferences(p: Preferences): string {
  const parts = [`quality x${p.qualityWeight}`, `cost x${p.costWeight}`, `speed x${p.speedWeight}`];
  if (p.openWeights !== 'any') parts.push(`open weights: ${p.openWeights}`);
  if (p.preferProviders.length) parts.push(`prefer ${p.preferProviders.join('/')}`);
  if (p.avoidProviders.length) parts.push(`avoid ${p.avoidProviders.join('/')}`);
  if (p.minQuality) parts.push(`min quality ${p.minQuality}`);
  return parts.join(', ');
}
