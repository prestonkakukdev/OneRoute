// Long-running commands (dev servers, watchers) started by the agent or by Preview. Each runs in its own process
// group so stopping it also stops what it spawned; output is kept in a bounded buffer; a local URL printed by the
// process (e.g. "Local: http://localhost:5173/") is picked up so the app can link to it.

import { type ChildProcess, spawn } from 'node:child_process';
import { agentEnv } from './env.js';

const MAX_BUFFER = 64 * 1024;
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)(?::\d+)?(?:\/[^\s'"`)\]]*)?/i;

export interface ProcessInfo {
  id: string;
  sessionId: string;
  command: string;
  label: string;
  pid?: number;
  status: 'running' | 'exited';
  exitCode?: number | null;
  url?: string;
  startedAt: string;
}

interface Entry extends ProcessInfo {
  child: ChildProcess;
  output: string;
  waiters: Set<() => void>;
}

// Background processes run in their own process groups, so they would outlive the server; stop them on shutdown.
const managers = new Set<ProcessManager>();
let shutdownRegistered = false;
function registerShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const stopAll = () => {
    for (const m of managers) m.stopAll();
  };
  process.once('exit', stopAll);
  for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
    process.once(sig, () => {
      stopAll();
      process.exit(code);
    });
  }
}

// Strips terminal colour codes from process output.
const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

export class ProcessManager {
  private readonly entries = new Map<string, Entry>();
  private seq = 0;

  constructor(private readonly onChange: (sessionId: string, info: ProcessInfo) => void = () => {}) {
    managers.add(this);
    registerShutdown();
  }

  stopAll(): void {
    for (const e of this.entries.values()) this.kill(e);
  }

  start(sessionId: string, command: string, cwd: string, label = command): ProcessInfo {
    this.seq += 1;
    const id = `p${this.seq}`;
    const child = spawn('/bin/bash', ['-c', command], { cwd, env: agentEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const entry: Entry = { id, sessionId, command, label, pid: child.pid, status: 'running', startedAt: new Date().toISOString(), child, output: '', waiters: new Set() };
    this.entries.set(id, entry);
    const onData = (d: Buffer) => {
      entry.output += plain(d.toString());
      if (entry.output.length > MAX_BUFFER) entry.output = entry.output.slice(-MAX_BUFFER);
      if (!entry.url) {
        const url = URL_RE.exec(entry.output)?.[0]?.replace('0.0.0.0', 'localhost');
        if (url) {
          entry.url = url;
          this.onChange(sessionId, this.info(entry));
        }
      }
      for (const w of entry.waiters) w();
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('close', (code) => {
      entry.status = 'exited';
      entry.exitCode = code;
      for (const w of entry.waiters) w();
      this.onChange(sessionId, this.info(entry));
    });
    child.on('error', (err) => {
      entry.output += `\nCould not start: ${err.message}\n`;
      entry.status = 'exited';
      entry.exitCode = -1;
      this.onChange(sessionId, this.info(entry));
    });
    this.onChange(sessionId, this.info(entry));
    return this.info(entry);
  }

  // Waits until the process prints a local URL, exits, or `ms` pass.
  async settle(id: string, ms: number, signal?: AbortSignal): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        entry.waiters.delete(check);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const check = () => {
        if (entry.url || entry.status === 'exited') done();
      };
      const timer = setTimeout(done, ms);
      entry.waiters.add(check);
      signal?.addEventListener('abort', done, { once: true });
      check();
    });
  }

  private info(e: Entry): ProcessInfo {
    const { child: _c, output: _o, waiters: _w, ...info } = e;
    return info;
  }

  list(sessionId: string): ProcessInfo[] {
    return [...this.entries.values()].filter((e) => e.sessionId === sessionId).map((e) => this.info(e));
  }

  get(sessionId: string, id: string): ProcessInfo | undefined {
    const e = this.entries.get(id);
    return e && e.sessionId === sessionId ? this.info(e) : undefined;
  }

  output(sessionId: string, id: string, tail = 8000): string | undefined {
    const e = this.entries.get(id);
    if (!e || e.sessionId !== sessionId) return undefined;
    return e.output.length > tail ? `[… earlier output cut …]\n${e.output.slice(-tail)}` : e.output;
  }

  // A running process for this session whose command matches (so Preview reuses a dev server that is already up).
  findRunning(sessionId: string, command: string): ProcessInfo | undefined {
    const e = [...this.entries.values()].find((x) => x.sessionId === sessionId && x.command === command && x.status === 'running');
    return e && this.info(e);
  }

  stop(sessionId: string, id: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.sessionId !== sessionId) return false;
    this.kill(e);
    return true;
  }

  stopSession(sessionId: string): void {
    for (const e of this.entries.values()) if (e.sessionId === sessionId) this.kill(e);
  }

  // Forgets exited processes of a session (keeps the list short).
  prune(sessionId: string): void {
    for (const [id, e] of this.entries) if (e.sessionId === sessionId && e.status === 'exited') this.entries.delete(id);
  }

  private kill(e: Entry): void {
    if (e.status !== 'running' || !e.pid) return;
    try {
      process.kill(-e.pid, 'SIGTERM'); // the whole process group
    } catch {
      try {
        e.child.kill('SIGTERM');
      } catch {}
    }
    const pid = e.pid;
    setTimeout(() => {
      if (e.status !== 'running') return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }, 3000).unref();
  }
}
