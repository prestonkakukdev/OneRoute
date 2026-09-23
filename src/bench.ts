import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { classifyWithJev } from './classifier/jev.js';
import type { Store } from './db/store.js';
import { requirementWeights } from './router/estimate.js';
import { Router } from './router/router.js';
import type { Mode } from './taxonomy.js';
import type { ChatRequest, ContentPart, ModelRecord, RouteDecision, TaskProfile } from './types.js';

// One routing test case. `expect` is the tier a sensible router should land in for balanced mode;
// `web` is whether live web search is expected.
export interface BenchCase {
  id: string;
  cat: string;
  prompt: string;
  expect?: 'cheap' | 'mid' | 'frontier';
  web?: boolean;
  images?: number;
  tools?: boolean;
  jsonSchema?: boolean;
  longDoc?: number; // tokens of synthetic document prepended to the prompt
}

export function loadCases(file: string): BenchCase[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => (l.startsWith('{') ? (JSON.parse(l) as BenchCase) : { id: `line-${i + 1}`, cat: 'uncategorized', prompt: l }));
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TOOLS = ['search', 'read_file', 'write_file', 'run_command', 'send_message', 'calendar_lookup'].map((name) => ({
  type: 'function',
  function: { name, description: `${name.replace('_', ' ')} tool`, parameters: { type: 'object', properties: {} } },
}));

// Synthetic filler of roughly `tokens` tokens, so long-context cases have a realistic size.
function syntheticDocument(tokens: number): string {
  const para = 'Section. The parties agree that the obligations described herein remain in effect unless amended in writing. ';
  return para.repeat(Math.ceil((tokens * 3.6) / para.length));
}

export function toRequest(c: BenchCase): ChatRequest {
  const text = c.longDoc ? `${syntheticDocument(c.longDoc)}\n\n${c.prompt}` : c.prompt;
  const content: string | ContentPart[] = c.images
    ? [{ type: 'text', text }, ...Array.from({ length: c.images }, () => ({ type: 'image_url', image_url: { url: TINY_PNG } }))]
    : text;
  return {
    messages: [{ role: 'user', content }],
    ...(c.tools ? { tools: TOOLS } : {}),
    ...(c.jsonSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' } } } } : {}),
  };
}

export interface BenchRow {
  id: string;
  cat: string;
  mode: Mode;
  expect?: string;
  model: string;
  effort: string;
  pSuccess: number;
  costUsd: number;
  latencyS: number;
  web: boolean;
  classifier: string;
  taskType: string;
  taskConfidence: number;
  difficulty: number;
  needs: Record<string, number>;
  escalated: boolean;
  flags: string[];
}

// Frontier = the model's top-effort skill on the capabilities this request needs is within 12 points
// of the best model's; used only for the sanity flags below.
function isFrontier(model: ModelRecord | undefined, best: number, d: RouteDecision): boolean {
  if (!model) return false;
  const top = model.efforts[model.efforts.length - 1]!;
  const needs = requirementWeights(d.task.taskType.value, d.task, d.facts);
  const caps = Object.keys(needs);
  const skill = caps.reduce((a, c) => a + (model.variantSkills[top]?.[c as keyof typeof needs]?.skill ?? 0), 0) / Math.max(caps.length, 1);
  return skill >= best - 12;
}

export async function runBench(
  store: Store,
  cases: BenchCase[],
  modes: Mode[],
  onRow?: (c: BenchCase, row: BenchRow) => void,
  classify: (state: unknown) => Promise<TaskProfile> = (s) => classifyWithJev(s),
) {
  // Jev is called once per case and reused for every mode.
  const cache = new Map<string, Promise<TaskProfile>>();
  const router = new Router(store, {
    classify: (state) => {
      const key = JSON.stringify(state);
      if (!cache.has(key)) cache.set(key, classify(state));
      return cache.get(key)!;
    },
  });
  const models = new Map(store.listModels().map((m) => [m.id, m]));
  const rows: BenchRow[] = [];
  for (const c of cases) {
    const req = toRequest(c);
    for (const mode of modes) {
      const d = await router.route(req, { mode, escalation: 'off' });
      const top = d.candidates[0]!;
      const needs = requirementWeights(d.task.taskType.value, d.task, d.facts);
      const bestSkill = Math.max(
        ...[...models.values()].map((m) => {
          const t = m.efforts[m.efforts.length - 1]!;
          const caps = Object.keys(needs);
          return caps.reduce((a, k) => a + (m.variantSkills[t]?.[k as keyof typeof needs]?.skill ?? 0), 0) / Math.max(caps.length, 1);
        }),
      );
      const flags: string[] = [];
      if (d.task.source !== 'jev') flags.push(`classifier fallback (${d.task.error ?? 'unknown'})`);
      // Web search has a fixed fee (~$0.01-0.02) whichever model runs; judge the model's own cost.
      const modelCost = top.estCostUsd - (d.useWeb ? (models.get(d.modelId)?.pricing.webSearchPerCall ?? 0.02) : 0);
      if (mode === 'balanced' && c.expect === 'cheap' && modelCost > 0.01) flags.push(`expensive for a simple request ($${top.estCostUsd.toFixed(4)})`);
      if (mode === 'balanced' && c.expect === 'frontier' && !isFrontier(models.get(d.modelId), bestSkill, d)) flags.push('non-frontier model for a hard request');
      if (mode === 'balanced' && c.expect === 'frontier' && (d.effort === 'none' || d.effort === 'minimal')) flags.push(`effort ${d.effort} for a hard request`);
      if (c.web !== undefined && c.web !== d.useWeb) flags.push(d.useWeb ? 'web search not expected' : 'web search expected but off');
      if (c.cat !== 'computer-use' && (needs.computer_use ?? 0) > 0.5) flags.push('computer_use weighted');
      if (c.expect !== 'frontier' && mode !== 'best' && top.estLatencyS > 60) flags.push(`slow for a routine request (${top.estLatencyS.toFixed(0)}s)`);
      const row: BenchRow = {
        id: c.id,
        cat: c.cat,
        mode,
        expect: c.expect,
        model: d.modelId,
        effort: d.effort,
        pSuccess: top.pSuccess,
        costUsd: top.estCostUsd,
        latencyS: top.estLatencyS,
        web: d.useWeb,
        classifier: d.task.source,
        taskType: d.task.taskType.value,
        taskConfidence: d.task.taskType.confidence,
        difficulty: d.task.difficulty.value,
        needs: Object.fromEntries(Object.entries(needs).map(([k, v]) => [k, Math.round(v * 100) / 100])),
        escalated: false,
        flags,
      };
      rows.push(row);
      onRow?.(c, row);
    }
  }
  return rows;
}

export function writeRows(file: string, rows: BenchRow[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function summarize(rows: BenchRow[]): string {
  const lines: string[] = [];
  for (const mode of [...new Set(rows.map((r) => r.mode))]) {
    const rs = rows.filter((r) => r.mode === mode);
    const avg = (f: (r: BenchRow) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    const byModel = new Map<string, number>();
    for (const r of rs) byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);
    const top = [...byModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([m, n]) => `${m} ${n}`).join(', ');
    lines.push(
      `${mode.padEnd(8)} avg est cost $${avg((r) => r.costUsd).toFixed(4)} · avg est latency ${avg((r) => r.latencyS).toFixed(1)}s · avg P ${(avg((r) => r.pSuccess) * 100).toFixed(0)}% · ${byModel.size} distinct models`,
      `         ${top}`,
    );
  }
  const flagged = rows.filter((r) => r.flags.length);
  lines.push('', `${flagged.length} flagged of ${rows.length} routes`);
  return lines.join('\n');
}
