// Verification: the checks OneRoute runs by itself when the agent says it is done. It finds the project's own test,
// type-check and lint commands, and for a plain web page (HTML opened straight from disk) loads it in a headless
// browser. Failures go back to the agent to fix before the run ends.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPage, formatPageCheck } from './browser.js';
import { agentEnv } from './env.js';
import { truncate } from './tools.js';

export interface Check {
  name: string;
  command?: string; // shell command; absent for the browser check
  page?: string; // project-relative HTML file for the browser check
}

export interface CheckResult extends Check {
  ok: boolean;
  output: string;
  ms: number;
  screenshot?: string; // browser check: file path
}

export function packageManager(folder: string): string {
  if (existsSync(join(folder, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(folder, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(folder, 'bun.lockb')) || existsSync(join(folder, 'bun.lock'))) return 'bun';
  return 'npm';
}

export function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const onPath = (bin: string) => (process.env.PATH ?? '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin']).some((d) => d && existsSync(join(d, bin)));

// The project's checks, cheapest first.
export function detectChecks(folder: string): Check[] {
  const checks: Check[] = [];
  const pkg = readJson(join(folder, 'package.json'));
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  const pm = packageManager(folder);
  const run = (s: string) => (pm === 'npm' ? `npm run -s ${s}` : `${pm} run ${s}`);
  for (const name of ['typecheck', 'type-check', 'check-types', 'tsc']) {
    if (scripts[name]) {
      checks.push({ name: 'Type check', command: run(name) });
      break;
    }
  }
  if (scripts.lint) checks.push({ name: 'Lint', command: run('lint') });
  const test = scripts.test;
  if (test && !/no test specified/.test(test)) checks.push({ name: 'Tests', command: pm === 'npm' ? 'npm test --silent' : `${pm} test` });
  else if (!pkg || !test) {
    // Node's built-in runner picks up *.test.js files without any setup.
    const hasNodeTests = safeList(folder).some((f) => /\.test\.(m?js|cjs)$/.test(f)) || safeList(join(folder, 'test')).some((f) => /\.(m?js|cjs)$/.test(f));
    if (hasNodeTests) checks.push({ name: 'Tests', command: 'node --test' });
  }
  if (existsSync(join(folder, 'Cargo.toml'))) checks.push({ name: 'Tests', command: 'cargo test --quiet' });
  if (existsSync(join(folder, 'go.mod'))) checks.push({ name: 'Tests', command: 'go test ./...' });
  const py = ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini'].some((f) => existsSync(join(folder, f))) || existsSync(join(folder, 'tests'));
  if (py && !pkg && onPath('pytest')) checks.push({ name: 'Tests', command: 'pytest -q' });
  if (!checks.some((c) => c.name === 'Tests') && existsSync(join(folder, 'Makefile')) && /^test:/m.test(readFileSync(join(folder, 'Makefile'), 'utf8'))) {
    checks.push({ name: 'Tests', command: 'make test' });
  }
  // A plain web page (no dev server or bundler): open it the way the user will, straight from disk.
  const bundled = Boolean(scripts.dev || scripts.start || scripts.build);
  if (!bundled && existsSync(join(folder, 'index.html'))) checks.push({ name: 'Browser', page: 'index.html' });
  return checks;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function runCommand(command: string, cwd: string, signal: AbortSignal, timeoutS = 300): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', command], { cwd, env: agentEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.length > 200_000) out = out.slice(0, 50_000) + out.slice(-50_000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(kill, timeoutS * 1000);
    signal.addEventListener('abort', kill, { once: true });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      resolve({ ok: code === 0, output: truncate(out.trim(), 6000) + (sig ? `\n[killed: ${signal.aborted ? 'stopped' : 'timed out'}]` : `\n[exit code ${code}]`) });
    });
    child.on('error', (err) => resolve({ ok: false, output: `Could not run: ${err.message}` }));
  });
}

export async function runChecks(folder: string, checks: Check[], signal: AbortSignal, screenshotDir?: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (signal.aborted) break;
    const started = Date.now();
    if (check.command) {
      const r = await runCommand(check.command, folder, signal);
      results.push({ ...check, ...r, ms: Date.now() - started });
    } else if (check.page) {
      try {
        const r = await checkPage({ url: `file://${join(folder, check.page)}`, signal, screenshotPath: screenshotDir ? join(screenshotDir, `verify-${Date.now()}.jpg`) : undefined });
        results.push({ ...check, ok: r.problems === 0, output: formatPageCheck(r), ms: Date.now() - started, ...(r.screenshot ? { screenshot: r.screenshot } : {}) });
      } catch (err) {
        // No browser on this machine: report it, but don't fail the run over it.
        results.push({ ...check, ok: true, output: `Skipped: ${(err as Error).message}`, ms: Date.now() - started });
      }
    }
  }
  return results;
}
