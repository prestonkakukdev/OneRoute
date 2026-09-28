import type { ContentPart } from './attachments';
import { storage } from './storage';

export type Mode = 'cheap' | 'balanced' | 'best';
export type WebSetting = 'auto' | 'on' | 'off';

export interface Preferences {
  qualityWeight?: number;
  costWeight?: number;
  speedWeight?: number;
  openWeights?: 'any' | 'prefer' | 'only';
  preferProviders?: string[];
  avoidProviders?: string[];
  minQuality?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentPart[];
}

type Dist = { value: number | string; probabilities: Record<string, number>; confidence: number };
export interface Candidate {
  modelId: string;
  effort: string;
  pSuccess: number;
  estCostUsd: number;
  estLatencyS: number;
  utility: number;
  breakdown?: { value: number; quality: number; cost: number; latency: number; preference: number };
}
export interface Decision {
  requestId: string;
  modelId: string;
  effort: string;
  mode: Mode;
  useWeb: boolean;
  webReason?: string;
  task: {
    taskType: Dist & { value: string };
    difficulty: Dist & { value: number };
    reasoningDepth: Dist;
    outputLength: Dist;
    capabilities: Record<string, number>;
    needsWeb: number;
    latencySensitive: number;
    highStakes: number;
    underspecified?: number;
    source: 'jev' | 'heuristic';
    latencyMs: number;
    error?: string;
  };
  facts: {
    inputTokens: number;
    hasImages: boolean;
    hasFiles: boolean;
    toolsPresent: boolean;
    attachments?: { images: number; pdfs: number; pdfPages: number; files: number };
  };
  candidates: Candidate[];
  escalation: { reasons: string[]; by: string; rationale?: string } | null;
  stickyModel?: string;
  needs?: Record<string, number>;
  rejected?: Record<string, string>;
  routeMs: number;
}
export interface Done {
  model: string;
  latencyMs: number;
  ttftMs?: number;
  usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number };
  sources?: { url: string; title: string }[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  mode: Mode;
  preferences: Preferences;
  web: WebSetting;
  escalation: 'auto' | 'off';
  sessionId: string;
  dryRun: boolean;
}

export type ChatEvent =
  | { event: 'decision'; data: { decision: Decision; why: string[] } }
  | { event: 'thinking'; data: unknown }
  | { event: 'delta'; data: { text: string } }
  | { event: 'done'; data: Done }
  | { event: 'error'; data: { message: string; status?: number } };

export function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const key = storage.get('key', '');
  if (key) h.authorization = `Bearer ${key}`;
  return h;
}

export async function streamChat(body: ChatRequest, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch('/ui/api/chat', { method: 'POST', headers: headers(), body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) onEvent({ event, data: JSON.parse(data) } as ChatEvent);
    }
  }
}

export async function sendFeedback(requestId: string, success: boolean, comment?: string): Promise<boolean> {
  const res = await fetch('/v1/feedback', { method: 'POST', headers: headers(), body: JSON.stringify({ request_id: requestId, success, comment }) });
  return res.ok;
}

// --- Saved chats ---------------------------------------------------------------------------------

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const chats = {
  list: () => fetch('/ui/api/chats', { headers: headers() }).then((r) => json<ChatSummary[]>(r)),
  get: <T>(id: string) => fetch(`/ui/api/chats/${encodeURIComponent(id)}`, { headers: headers() }).then((r) => json<{ id: string; title: string; turns: T[] }>(r)),
  saveTurn: (chatId: string, turn: { id: string }, title: string) =>
    fetch(`/ui/api/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(turn.id)}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ title, turn }),
    }).then((r) => json<{ ok: true }>(r)),
  rename: (id: string, title: string) =>
    fetch(`/ui/api/chats/${encodeURIComponent(id)}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ title }) }).then((r) => json<{ ok: true }>(r)),
  remove: (id: string) => fetch(`/ui/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() }).then((r) => json<{ ok: true }>(r)),
};
