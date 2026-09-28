// Context compaction. Long sessions outgrow the model's context (and, in Cheap mode, the budget). Two steps, cheapest
// first: old tool output is cleared (the agent can re-run a tool if it needs it again), then, if that isn't enough,
// the older part of the conversation is replaced by a summary written by the same model. The system prompt and the
// most recent turns always stay verbatim.

import type { Mode } from '../taxonomy.js';
import type { ChatMessage } from '../types.js';

// Prompt-token budgets per mode, before the model's own context limit.
const BUDGET: Record<Mode, number> = { cheap: 48_000, balanced: 128_000, best: 256_000 };

export function compactionLimits(mode: Mode, contextLength: number): { prune: number; summarize: number } {
  const limit = Math.min(BUDGET[mode] ?? BUDGET.balanced, Math.floor((contextLength || 128_000) * 0.75));
  return { prune: Math.floor(limit * 0.6), summarize: limit };
}

const text = (m: ChatMessage): string => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => ('text' in p ? String(p.text) : '')).join('') : '');

const CLEARED = '[older output cleared to save context; run the tool again if you need it]';

// Clears the output of all but the most recent tool results. Returns how many characters it saved. Nothing changes
// unless it would save at least `minSave` characters: every change to earlier messages throws away the provider's
// prompt cache from that point on, so clearing is done in large batches rather than a little on every step.
export function pruneToolResults(messages: ChatMessage[], keepRecent = 3, minSave = 8000): number {
  const toolIdx = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  const edits: [number, string][] = [];
  let saved = 0;
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent))) {
    const body = text(messages[i]!);
    if (body.length <= 600 || body.endsWith(CLEARED)) continue;
    const next = `${body.slice(0, 300)}\n${CLEARED}`;
    saved += body.length - next.length;
    edits.push([i, next]);
  }
  if (saved < minSave) return 0;
  for (const [i, next] of edits) messages[i] = { ...messages[i]!, content: next };
  return saved;
}

// Where to cut for a summary: after the system prompt, before the last `keepRecent` messages, at a message that
// starts a turn (a tool result must stay with the call that asked for it).
export function summaryCut(messages: ChatMessage[], keepRecent = 8): number | null {
  for (let c = messages.length - keepRecent; c > 2; c--) {
    const m = messages[c]!;
    if (m.role === 'user' || (m.role === 'assistant' && messages[c - 1]?.role !== 'assistant')) return c;
  }
  return null;
}

// The older messages as plain text for the summariser.
export function transcript(messages: ChatMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    const body = text(m);
    if (m.role === 'user') out.push(`USER: ${body}`);
    else if (m.role === 'assistant') {
      if (body.trim()) out.push(`AGENT: ${body}`);
      for (const tc of (m as { tool_calls?: { function: { name: string; arguments: string } }[] }).tool_calls ?? []) {
        out.push(`AGENT CALLED ${tc.function.name}(${tc.function.arguments.length > 600 ? `${tc.function.arguments.slice(0, 600)}…` : tc.function.arguments})`);
      }
    } else if (m.role === 'tool') out.push(`RESULT: ${body.length > 1200 ? `${body.slice(0, 800)}\n…\n${body.slice(-400)}` : body}`);
  }
  const all = out.join('\n\n');
  return all.length > 120_000 ? `${all.slice(0, 40_000)}\n\n[…]\n\n${all.slice(-80_000)}` : all;
}

export const SUMMARY_PROMPT = `You are compacting the history of a coding session so the agent can continue it with less context.
Write a dense summary for the agent that will carry on. Include:
- The user's goal and every requirement or preference they stated (quote exact wording where it matters).
- What has been done: files created or changed (paths) and what changed in them.
- Decisions made and why; approaches that failed and should not be retried.
- The current state: what works, what is broken, the latest test/check results, errors still open.
- Exactly what remains to do next.
Keep paths, commands, identifiers and error messages exact. No preamble.`;

export const summaryMessage = (summary: string): ChatMessage => ({
  role: 'user',
  content: `[Summary of the earlier part of this session, written to save context. Files may have changed since; read them again before editing.]\n\n${summary}`,
});
