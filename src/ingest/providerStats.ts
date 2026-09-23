import { config } from '../config.js';

export const OPENROUTER_STATS_SOURCE = 'openrouter.ai/endpoints';

export interface ProviderStats {
  tps: number; // median output tokens/sec across providers, weighted by recent requests
  latencyS: number; // median time to first token (includes thinking at the provider's default effort)
  uptime: number; // 0-1, last day, request-weighted
  providers: number;
  requests: number;
  measuredAt: string;
}

interface Endpoint {
  status?: number;
  uptime_last_1d?: number | null;
  latency_last_30m?: { p50?: number | null } | null;
  throughput_last_30m?: { p50?: number | null } | null;
  perf_last_30m_by_workload?: Record<string, { request_count?: number }> | null;
}

// Live production speed and reliability from OpenRouter's per-provider stats (last 30 minutes / 1 day).
export async function fetchProviderStats(modelId: string, fetchImpl: typeof fetch = fetch): Promise<ProviderStats | undefined> {
  const res = await fetchImpl(`${config.openRouterBaseUrl}/models/${modelId}/endpoints`, {
    headers: config.openRouterKey ? { Authorization: `Bearer ${config.openRouterKey}` } : {},
  });
  if (!res.ok) return undefined;
  const endpoints = ((await res.json()) as { data?: { endpoints?: Endpoint[] } }).data?.endpoints ?? [];
  let w = 0;
  let tps = 0;
  let lat = 0;
  let up = 0;
  let requests = 0;
  for (const e of endpoints) {
    const t = e.throughput_last_30m?.p50;
    const l = e.latency_last_30m?.p50;
    if (!t || !l) continue;
    const n = Object.values(e.perf_last_30m_by_workload ?? {}).reduce((a, x) => a + (x.request_count ?? 0), 0);
    const weight = Math.max(n, 1);
    tps += t * weight;
    lat += (l / 1000) * weight;
    up += ((e.uptime_last_1d ?? 100) / 100) * weight;
    w += weight;
    requests += n;
  }
  if (!w) return undefined;
  return { tps: tps / w, latencyS: lat / w, uptime: up / w, providers: endpoints.length, requests, measuredAt: new Date().toISOString() };
}
