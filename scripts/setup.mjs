// First-time setup: `npm install && npm run setup`.
//   1. checks the Node version
//   2. creates .env from .env.example and asks for the two API keys (skipped when already set)
//   3. builds the router and the app
//   4. checks both keys with a live call
// Safe to run again at any time.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = join(ROOT, '.env');
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const step = (s) => console.log(`\n${bold(s)}`);

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(red(`Node ${process.versions.node} is too old: System1 Route needs Node 22.13 or newer (it uses the built-in SQLite).`));
  process.exit(1);
}

step('1. API keys');
if (!existsSync(ENV)) {
  copyFileSync(join(ROOT, '.env.example'), ENV);
  console.log('Created .env from .env.example');
}
const KEYS = [
  ['OPENROUTER_API_KEY', 'OpenRouter API key (runs the models; https://openrouter.ai/keys)'],
  ['TYPESAFE_API_KEY', 'Jev / TypeSafe API key (reads each request; https://typesafe.ai)'],
];
let env = readFileSync(ENV, 'utf8');
const current = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? '';
const missing = KEYS.filter(([name]) => !current(name));
if (missing.length && process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (const [name, label] of missing) {
    const value = (await rl.question(`${label}\n> `)).trim();
    if (!value) continue;
    env = new RegExp(`^${name}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${value}`) : `${env.trimEnd()}\n${name}=${value}\n`;
  }
  rl.close();
  writeFileSync(ENV, env);
}
for (const [name] of KEYS) console.log(`${current(name) ? '✓' : red('✗')} ${name}${current(name) ? '' : ' is empty: add it to .env'}`);

step('2. Build');
execFileSync('npm', ['run', 'build', '--silent'], { cwd: ROOT, stdio: 'inherit' });
console.log('✓ Router and app built');

step('3. Check the keys');
const check = spawnSync(process.execPath, [join(ROOT, 'dist', 'cli', 'index.js'), 'check'], { cwd: ROOT, stdio: 'inherit' });

step('Next');
console.log(`Start it:            npm start            then open http://localhost:8787`);
if (process.platform === 'darwin') console.log(`Or keep it running:  npm run service -- install   (starts at login, restarts itself)`);
console.log(`Use it from code:    any OpenAI client with base URL http://localhost:8787/v1 and model "auto"`);
if (check.status !== 0) {
  console.log(red('\nThe key check failed: fix the keys in .env and run `npm run setup` again.'));
  process.exit(1);
}
