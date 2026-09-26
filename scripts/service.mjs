// Keeps the router running for the background service (launchd runs this file; see `mrouter service`).
//
//   - Starts the router and restarts it when it crashes (with backoff) or when its code or .env changes.
//   - Rebuilds the app (web/dist) whenever the interface source changes; the router serves the new
//     files on the next refresh.
//   - Keeps the log file from growing without bound.
//
// Plain JavaScript so it runs without a build step. Stop it with `mrouter service stop` (launchd would
// otherwise restart it).

import { spawn } from 'node:child_process';
import { existsSync, statSync, truncateSync, watch } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.ROUTER_PORT ?? '8787';
const LOG_FILE = process.env.ROUTER_LOG_FILE;
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const node = process.execPath;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (who, msg) => console.log(`${stamp()} [${who}] ${msg}`);

function trimLog() {
  if (!LOG_FILE || !existsSync(LOG_FILE)) return;
  try {
    if (statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      truncateSync(LOG_FILE, 0);
      log('service', 'log file passed 10 MB and was cleared');
    }
  } catch {}
}

// One supervised child process: restarted after crashes with exponential backoff (1s up to 30s,
// reset once it has stayed up for a minute), and on demand after code changes.
const ANSI = /\x1b\[[0-9;]*m/g;

function supervise(name, args, keep = () => true) {
  let child;
  let backoff = 1000;
  let startedAt = 0;
  let stopping = false;
  let restartTimer;

  const start = () => {
    startedAt = Date.now();
    child = spawn(node, args, { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) {
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const raw of lines) {
          const line = raw.replace(ANSI, '');
          if (line.trim() && keep(line)) log(name, line);
        }
      });
    }
    child.on('exit', (code, signal) => {
      child = undefined;
      if (stopping) return;
      if (Date.now() - startedAt > 60_000) backoff = 1000;
      log(name, `exited (${signal ?? `code ${code}`}); restarting in ${backoff / 1000}s`);
      restartTimer = setTimeout(start, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
  };

  return {
    start,
    // Restart now (after a code change): kill the current process; the exit handler brings it back.
    restart(reason) {
      log(name, `restarting: ${reason}`);
      backoff = 1000;
      clearTimeout(restartTimer);
      if (child) child.kill('SIGTERM');
      else start();
    },
    stop() {
      stopping = true;
      clearTimeout(restartTimer);
      child?.kill('SIGTERM');
    },
  };
}

const router = supervise('router', ['--import', 'tsx', 'src/cli/index.ts', 'serve', '--port', PORT]);
// Vite lists every output file on each rebuild; the log keeps only build results, warnings and errors.
const webBuild = supervise(
  'web',
  [join('node_modules', 'vite', 'bin', 'vite.js'), 'build', '--watch', '--config', join('web', 'vite.config.ts')],
  (line) => !/^\s*web\/dist\/|^\s*(transforming|rendering chunks|computing gzip|✓ \d+ modules transformed)/i.test(line),
);

// Restart the router when its code, data files or keys change (debounced: a `git pull` touches many files).
let pending;
const changed = new Set();
function onChange(file) {
  changed.add(file);
  clearTimeout(pending);
  pending = setTimeout(() => {
    const files = [...changed].slice(0, 3).join(', ') + (changed.size > 3 ? ` and ${changed.size - 3} more` : '');
    changed.clear();
    router.restart(`changed ${files}`);
  }, 400);
}
for (const dir of ['src', 'data']) {
  const path = join(ROOT, dir);
  if (!existsSync(path)) continue;
  watch(path, { recursive: true }, (_event, file) => {
    if (!file || file.includes('cache/') || file.endsWith('.db') || file.startsWith('.')) return;
    onChange(relative(ROOT, join(path, file)));
  });
}
watch(ROOT, (_event, file) => {
  if (file === '.env' || file === 'package.json') onChange(file);
});

const shutdown = (signal) => {
  log('service', `${signal}: stopping`);
  router.stop();
  webBuild.stop();
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

trimLog();
setInterval(trimLog, 60 * 60 * 1000).unref();
log('service', `starting in ${ROOT} (node ${process.version}, port ${PORT})`);
router.start();
webBuild.start();
