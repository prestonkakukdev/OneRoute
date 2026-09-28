import { headers } from '@/lib/api';

export type Mode = 'cheap' | 'balanced' | 'best';
export type Permission = 'auto' | 'ask' | 'plan';

export interface CodeProject {
  id: string;
  name: string;
  path: string;
}

export interface CodeSession {
  id: string;
  projectId: string;
  title: string;
  branch: string;
  worktree: string;
  baseRef: string;
  inPlace: boolean;
  status: string;
  costUsd: number;
  updatedAt: string;
  running?: boolean;
}

export interface CodeEvent {
  seq?: number;
  type: string;
  data: Record<string, unknown>;
}

export interface CodeMemory {
  id: string;
  text: string;
  source: 'learned' | 'user';
  createdAt: string;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  home: string;
  entries: { name: string; path: string; git: boolean }[];
}

export interface ProcessInfo {
  id: string;
  command: string;
  label: string;
  status: 'running' | 'exited';
  exitCode?: number | null;
  url?: string;
  startedAt: string;
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const base = '/ui/api/code';
const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });

export const codeApi = {
  projects: () => send('GET', '/projects').then((r) => json<CodeProject[]>(r)),
  addProject: (path: string) => send('POST', '/projects', { path }).then((r) => json<CodeProject>(r)),
  removeProject: (id: string) => send('DELETE', `/projects/${id}`).then((r) => json<{ ok: boolean }>(r)),
  sessions: () => send('GET', '/sessions').then((r) => json<CodeSession[]>(r)),
  // Finder's folder chooser on this Mac: the chosen path, null if cancelled; throws 'unsupported' elsewhere.
  chooseFolder: async (): Promise<string | null> => {
    const res = await send('POST', '/choose-folder');
    if (res.status === 501) throw new Error('unsupported');
    return (await json<{ path: string | null }>(res)).path;
  },
  browse: (path?: string) => send('GET', `/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`).then((r) => json<FolderListing>(r)),
  start: (projectId: string, prompt: string, mode: Mode, permission: Permission, isolated: boolean) =>
    send('POST', '/sessions', { projectId, prompt, mode, permission, isolated }).then((r) => json<CodeSession>(r)),
  undo: (id: string) => send('POST', `/sessions/${id}/undo`).then((r) => json<{ restored: number }>(r)),
  message: (id: string, prompt: string, mode: Mode, permission: Permission) =>
    send('POST', `/sessions/${id}/messages`, { prompt, mode, permission }).then((r) => json<{ ok: boolean }>(r)),
  approve: (id: string, approvalId: string, allow: boolean) => send('POST', `/sessions/${id}/approvals/${approvalId}`, { allow }).then((r) => json<{ ok: boolean }>(r)),
  stop: (id: string) => send('POST', `/sessions/${id}/stop`).then((r) => json<{ ok: boolean }>(r)),
  diff: (id: string) => send('GET', `/sessions/${id}/diff`).then((r) => json<{ files: DiffFile[]; patch: string }>(r)),
  save: (id: string) => send('POST', `/sessions/${id}/save`).then((r) => json<{ commit: string | null }>(r)),
  discard: (id: string) => send('DELETE', `/sessions/${id}`).then((r) => json<{ ok: boolean }>(r)),
  memory: (projectId: string) => send('GET', `/projects/${projectId}/memory`).then((r) => json<CodeMemory[]>(r)),
  addMemory: (projectId: string, text: string) => send('POST', `/projects/${projectId}/memory`, { text }).then((r) => json<CodeMemory>(r)),
  editMemory: (projectId: string, id: string, text: string) => send('PATCH', `/projects/${projectId}/memory/${id}`, { text }).then((r) => json<{ ok: boolean }>(r)),
  deleteMemory: (projectId: string, id: string) => send('DELETE', `/projects/${projectId}/memory/${id}`).then((r) => json<{ ok: boolean }>(r)),
  resume: (id: string, mode: Mode, permission: Permission) => send('POST', `/sessions/${id}/resume`, { mode, permission }).then((r) => json<{ ok: boolean }>(r)),
  rename: (id: string, title: string) => send('PATCH', `/sessions/${id}`, { title }).then((r) => json<{ ok: boolean }>(r)),
  restore: (id: string, turn: number) => send('POST', `/sessions/${id}/restore`, { turn }).then((r) => json<{ restored: number }>(r)),
  preview: (id: string) => send('POST', `/sessions/${id}/preview`).then((r) => json<{ url?: string; kind: 'dev' | 'static'; process?: ProcessInfo }>(r)),
  processes: (id: string) => send('GET', `/sessions/${id}/processes`).then((r) => json<ProcessInfo[]>(r)),
  processOutput: async (id: string, pid: string) => {
    const res = await send('GET', `/sessions/${id}/processes/${pid}/output`);
    return res.ok ? res.text() : '';
  },
  stopProcess: (id: string, pid: string) => send('POST', `/sessions/${id}/processes/${pid}/stop`).then((r) => json<{ ok: boolean }>(r)),
  clearProcesses: (id: string) => send('DELETE', `/sessions/${id}/processes`).then((r) => json<{ ok: boolean }>(r)),
  // Screenshots need the API key header, so they are fetched and shown from a blob URL.
  screenshot: async (id: string, name: string): Promise<string> => {
    const res = await send('GET', `/sessions/${id}/screenshots/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return URL.createObjectURL(await res.blob());
  },
};

// Follows a session's timeline: stored events first, then live ones. Reconnects from the last event if the
// connection drops (e.g. the server restarted).
export function followSession(id: string, onEvent: (e: CodeEvent) => void, onReady: (running: boolean) => void): () => void {
  let stopped = false;
  let after = 0;
  let controller: AbortController | undefined;
  const loop = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`${base}/sessions/${id}/events?after=${after}`, { headers: headers(), signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
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
            if (!data || event === 'ping') continue;
            const parsed = JSON.parse(data) as { seq?: number; data?: Record<string, unknown>; running?: boolean };
            if (event === 'ready') {
              onReady(Boolean(parsed.running));
              continue;
            }
            if (parsed.seq) after = Math.max(after, parsed.seq);
            onEvent({ seq: parsed.seq, type: event, data: parsed.data ?? {} });
          }
        }
      } catch {
        if (stopped) return;
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 1500));
    }
  };
  void loop();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
