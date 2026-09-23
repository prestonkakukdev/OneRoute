import { fetchModels, parseOpenRouterModel } from '../providers/openrouter.js';
import type { Store } from './store.js';

export interface SyncReport {
  updated: string[];
  missing: string[]; // tracked models OpenRouter no longer lists
  untracked: { id: string; name: string; created: string }[]; // recent models we have no quality data for yet
}

const DAY = 24 * 3600;

// Refreshes pricing, context, modalities and effort levels from OpenRouter. Quality data is
// never touched here: it only changes through evals and feedback.
export async function syncFromOpenRouter(store: Store): Promise<SyncReport> {
  const remote = await fetchModels();
  const byId = new Map(remote.map((m) => [m.id, m]));
  const tracked = store.listModels({ includeDisabled: true });
  const trackedIds = new Set(tracked.map((m) => m.id));
  const providers = new Set(tracked.map((m) => m.provider));
  const report: SyncReport = { updated: [], missing: [], untracked: [] };
  const at = new Date().toISOString();

  for (const m of tracked) {
    const raw = byId.get(m.id);
    if (!raw) {
      report.missing.push(m.id);
      continue;
    }
    store.upsertModel({ ...m, ...parseOpenRouterModel(raw), updatedAt: at });
    report.updated.push(m.id);
  }

  const cutoff = Date.now() / 1000 - 60 * DAY;
  for (const raw of remote) {
    const provider = raw.id.split('/')[0]!;
    if (!providers.has(provider) || raw.id.includes(':') || trackedIds.has(raw.id) || (raw.created ?? 0) < cutoff) continue;
    report.untracked.push({ id: raw.id, name: raw.name, created: new Date((raw.created ?? 0) * 1000).toISOString().slice(0, 10) });
  }
  report.untracked.sort((a, b) => b.created.localeCompare(a.created));
  return report;
}
