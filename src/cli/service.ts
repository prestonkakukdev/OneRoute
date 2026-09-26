// `s1route service`: runs the router in the background on macOS (a launchd agent). It starts at login,
// comes back after crashes, restarts itself when the code changes and rebuilds the app when the
// interface changes (scripts/service.mjs does the supervising).

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_LABEL = 'com.system1route.service';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
export const LOG_FILE = join(homedir(), 'Library', 'Logs', 'System1Route', 'service.log');
const domain = () => `gui/${userInfo().uid}`;
const target = () => `${domain()}/${SERVICE_LABEL}`;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function requireMac(): void {
  if (process.platform !== 'darwin') throw new Error('The background service uses launchd and is macOS only. Run `s1route serve` instead.');
}

// A stable node path: Homebrew's /opt/homebrew/bin/node survives upgrades, the versioned Cellar path does not.
function nodePath(): string {
  const found = spawnSync('/bin/sh', ['-lc', 'command -v node'], { encoding: 'utf8' }).stdout.trim();
  return found || process.execPath;
}

export function plistFor(opts: { node: string; port: number }): string {
  const env: Record<string, string> = {
    PATH: `${dirname(opts.node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ROUTER_PORT: String(opts.port),
    ROUTER_LOG_FILE: LOG_FILE,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(opts.node)}</string>
    <string>${xml(join(ROOT, 'scripts', 'service.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG_FILE)}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[], allowFail = false): { ok: boolean; out: string } {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0 && !allowFail) throw new Error(`launchctl ${args.join(' ')} failed: ${out}`);
  return { ok: r.status === 0, out };
}

export function serviceState(): { installed: boolean; loaded: boolean; running: boolean; pid?: number; lastExit?: string } {
  const installed = existsSync(PLIST);
  const r = launchctl(['print', target()], true);
  if (!r.ok) return { installed, loaded: false, running: false };
  const pid = /\bpid = (\d+)/.exec(r.out)?.[1];
  return {
    installed,
    loaded: true,
    running: /\bstate = running\b/.test(r.out),
    pid: pid ? Number(pid) : undefined,
    lastExit: /last exit code = ([^\n]+)/.exec(r.out)?.[1]?.trim(),
  };
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(port: number, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds * 2; i++) {
    if (await healthy(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Agents from before the project was renamed; install replaces them.
const LEGACY_LABELS = ['com.modelrouter.service'];

function removeLegacyAgents(): void {
  for (const label of LEGACY_LABELS) {
    launchctl(['bootout', `${domain()}/${label}`], true);
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    if (existsSync(plist)) {
      rmSync(plist);
      console.log(`Removed the old ${label} agent`);
    }
  }
}

export async function installService(port: number): Promise<void> {
  requireMac();
  removeLegacyAgents();
  if (serviceState().loaded) launchctl(['bootout', target()], true);
  // A service that was just stopped can take a moment to let go of the port.
  for (let i = 0; i < 10 && (await healthy(port)); i++) await new Promise((r) => setTimeout(r, 500));
  if (await healthy(port)) {
    throw new Error(`Something is already answering on port ${port} (a \`s1route serve\` or dev server?). Stop it first, then install again.`);
  }
  mkdirSync(dirname(PLIST), { recursive: true });
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  writeFileSync(PLIST, plistFor({ node: nodePath(), port }));
  launchctl(['enable', target()], true);
  launchctl(['bootstrap', domain(), PLIST]);
  console.log(`Installed ${SERVICE_LABEL} (${PLIST})`);
  console.log(`Starting… (first start builds the app)`);
  if (await waitHealthy(port, 45)) console.log(`Running on http://localhost:${port}/ — it starts at login and restarts itself after crashes and code changes.`);
  else console.log(`Not answering yet. Check \`s1route service logs\` (${LOG_FILE}).`);
}

export function uninstallService(): void {
  requireMac();
  removeLegacyAgents();
  launchctl(['bootout', target()], true);
  if (existsSync(PLIST)) rmSync(PLIST);
  console.log('Background service removed. Logs stay in ' + LOG_FILE);
}

export async function startService(port: number): Promise<void> {
  requireMac();
  if (!existsSync(PLIST)) throw new Error('The service is not installed. Run `s1route service install`.');
  if (!serviceState().loaded) launchctl(['bootstrap', domain(), PLIST]);
  else launchctl(['kickstart', target()]);
  console.log((await waitHealthy(port, 45)) ? `Running on http://localhost:${port}/` : `Started, but not answering yet. See \`s1route service logs\`.`);
}

export function stopService(): void {
  requireMac();
  // bootout stops it and keeps launchd from restarting it; it comes back at next login (or `service start`).
  launchctl(['bootout', target()], true);
  console.log('Stopped until the next login (or `s1route service start`).');
}

export async function restartService(port: number): Promise<void> {
  requireMac();
  if (!serviceState().loaded) return startService(port);
  launchctl(['kickstart', '-k', target()]);
  console.log((await waitHealthy(port, 45)) ? `Restarted: http://localhost:${port}/` : 'Restarted, but not answering yet. See `s1route service logs`.');
}

export async function printStatus(port: number): Promise<void> {
  requireMac();
  const s = serviceState();
  const up = await healthy(port);
  console.log(`installed: ${s.installed ? 'yes' : 'no'} (${PLIST})`);
  console.log(`running:   ${s.running ? `yes, pid ${s.pid}` : 'no'}${s.lastExit && s.lastExit !== '(never exited)' ? ` · last exit: ${s.lastExit}` : ''}`);
  console.log(`answering: ${up ? `yes, http://localhost:${port}/` : 'no'}`);
  console.log(`logs:      ${LOG_FILE}`);
}

export function showLogs(lines: number, follow: boolean): void {
  if (!existsSync(LOG_FILE)) {
    console.log(`No log yet (${LOG_FILE}).`);
    return;
  }
  if (!follow) {
    process.stdout.write(execFileSync('tail', ['-n', String(lines), LOG_FILE], { encoding: 'utf8' }));
    return;
  }
  spawn('tail', ['-n', String(lines), '-f', LOG_FILE], { stdio: 'inherit' });
}
