#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import { serve } from '@hono/node-server';
import { Command, InvalidArgumentError } from 'commander';
import { buildJevState, extractFacts } from '../classifier/state.js';
import { classifyWithJev } from '../classifier/jev.js';
import { config } from '../config.js';
import { CALIBRATION_PRIOR, Store } from '../db/store.js';
import { rebuildCalibration } from '../learning/calibration.js';
import { syncFromOpenRouter } from '../db/sync.js';
import { fetchAaModels, type AaModel } from '../ingest/aa.js';
import { arenaResults, fetchArenaCategory, LMARENA_CATEGORIES } from '../ingest/lmarena.js';
import { runPipeline } from '../ingest/pipeline.js';
import { fetchProviderStats } from '../ingest/providerStats.js';
import { ModelResolver } from '../ingest/resolve.js';
import { loadVendorResults, type ExternalResult } from '../ingest/vendor.js';
import { generateProfiles } from '../ingest/profiles.js';
import { loadCases, runBench, summarize, writeRows } from '../bench.js';
import { fetchModels } from '../providers/openrouter.js';
import { Executor } from '../gateway/execute.js';
import { appBuilt, createApp } from '../gateway/server.js';
import { installService, printStatus, restartService, showLogs, startService, stopService, uninstallService } from './service.js';
import { readSse } from '../gateway/sse.js';
import { explainDecision, summaryLine } from '../router/explain.js';
import { RoutingError } from '../router/optimizer.js';
import { Router } from '../router/router.js';
import { CAPABILITY_KEYS, MODES, type Dimension, type Effort, type Mode } from '../taxonomy.js';
import type { ChatMessage, ChatRequest, ModelRecord, Preferences, RouteDecision } from '../types.js';

const dim = (s: string) => styleText('dim', s);
const red = (s: string) => styleText('red', s);

function parseMode(value: string): Mode {
  if (!MODES.includes(value as Mode)) throw new InvalidArgumentError(`mode must be one of ${MODES.join(', ')}`);
  return value as Mode;
}

// --pref quality=3 --pref open=prefer --pref prefer=anthropic,google --pref avoid=x-ai --pref min=50
const PREF_KEYS: Record<string, keyof Preferences> = {
  quality: 'qualityWeight',
  cost: 'costWeight',
  speed: 'speedWeight',
  open: 'openWeights',
  prefer: 'preferProviders',
  avoid: 'avoidProviders',
  min: 'minQuality',
};
function parsePref(value: string, acc: Partial<Preferences> = {}): Partial<Preferences> {
  const [k, v] = value.split('=');
  const key = PREF_KEYS[k ?? ''];
  if (!key || v === undefined) throw new InvalidArgumentError(`use key=value with key one of ${Object.keys(PREF_KEYS).join(', ')}`);
  if (key === 'openWeights') {
    if (!['any', 'prefer', 'only'].includes(v)) throw new InvalidArgumentError('open must be any, prefer or only');
    return { ...acc, openWeights: v as Preferences['openWeights'] };
  }
  if (key === 'preferProviders' || key === 'avoidProviders') return { ...acc, [key]: v.split(',').filter(Boolean) };
  return { ...acc, [key]: parseNumber(v) };
}

function parseNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new InvalidArgumentError('must be a number');
  return n;
}

function warnAppNotBuilt(): void {
  if (!appBuilt()) console.log(red('The app is not built yet: run `npm run web:build` (the API works without it).'));
}

function warnMissingKeys(): void {
  if (!existsSync(config.dbPath)) console.error(dim('No capability database yet: run `mrouter ingest` first (bootstrap priors are used until then).'));
  if (!config.typesafeKey) console.error(dim('TYPESAFE_API_KEY not set: using the keyword fallback classifier.'));
  if (!config.openRouterKey) console.error(dim('OPENROUTER_API_KEY not set: models cannot be called.'));
}

const program = new Command()
  .name('mrouter')
  .description('Semantic LLM router: Jev reads the task, a deterministic optimizer picks the model and reasoning effort.');

program
  .command('chat')
  .description('Chat in the terminal; every turn is routed to the best model')
  .option('-m, --mode <mode>', 'cheap | balanced | best', parseMode, config.defaultMode)
  .option('-s, --system <prompt>', 'system prompt')
  .option('--pref <key=value>', 'preference (repeatable): quality=N cost=N speed=N open=any|prefer|only prefer=a,b avoid=a,b min=N', parsePref, {})
  .action(async (opts: { mode: Mode; system?: string; pref: Partial<Preferences> }) => {
    warnMissingKeys();
    const store = new Store(config.dbPath);
    const router = new Router(store);
    const executor = new Executor(store);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const sessionId = `cli_${randomUUID()}`;
    let mode = opts.mode;
    let messages: ChatMessage[] = opts.system ? [{ role: 'system', content: opts.system }] : [];
    let last: RouteDecision | undefined;

    console.log(dim(`mode ${mode} · commands: /good /bad [note] /why /mode <m> /new /exit`));
    for (;;) {
      let input: string;
      try {
        input = (await rl.question(styleText('cyan', '\nyou › '))).trim();
      } catch {
        break; // stdin closed
      }
      if (!input) continue;

      if (input.startsWith('/')) {
        const [cmd, ...rest] = input.split(/\s+/);
        const note = rest.join(' ') || undefined;
        if (cmd === '/exit' || cmd === '/quit') break;
        else if (cmd === '/new') {
          messages = opts.system ? [{ role: 'system', content: opts.system }] : [];
          console.log(dim('conversation cleared'));
        } else if (cmd === '/mode' && rest[0] && MODES.includes(rest[0] as Mode)) {
          mode = rest[0] as Mode;
          console.log(dim(`mode ${mode}`));
        } else if (cmd === '/why') console.log(last ? explainDecision(last) : dim('nothing routed yet'));
        else if ((cmd === '/good' || cmd === '/bad') && last) {
          store.recordFeedback(last.requestId, cmd === '/good', undefined, note);
          console.log(dim(`recorded ${cmd.slice(1)} for ${last.modelId} on ${last.task.taskType.value}`));
        } else console.log(dim('commands: /good /bad [note] /why /mode <cheap|balanced|best> /new /exit'));
        continue;
      }

      messages.push({ role: 'user', content: input });
      const req: ChatRequest = { messages, stream: true };
      try {
        last = await router.route(req, { mode, sessionId, preferences: opts.pref });
      } catch (err) {
        console.log(red((err as Error).message));
        messages.pop();
        continue;
      }
      console.log(dim(`→ ${summaryLine(last)}`));

      const started = performance.now();
      let result;
      try {
        result = await executor.execute(req, last);
      } catch (err) {
        console.log(red((err as Error).message));
        messages.pop();
        continue;
      }
      if (!result.response.ok || !result.response.body) {
        console.log(red(`request failed (${result.response.status}): ${(await result.response.text()).slice(0, 500)}`));
        messages.pop();
        continue;
      }
      if (result.servedModel !== last.modelId) console.log(dim(`(fell back to ${result.servedModel})`));

      let answer = '';
      let cost: number | undefined;
      let thinking = false;
      process.stdout.write('\n');
      for await (const ev of readSse(result.response.body)) {
        const e = ev as {
          choices?: { delta?: { content?: string; reasoning?: string } }[];
          usage?: { cost?: number };
          error?: { message?: string };
        };
        if (e.error) process.stdout.write(red(`\n[error] ${e.error.message ?? 'unknown'}`));
        const delta = e.choices?.[0]?.delta;
        if (delta?.reasoning && !thinking && !answer) {
          thinking = true;
          process.stdout.write(dim('thinking… '));
        }
        if (delta?.content) {
          if (thinking && !answer) process.stdout.write('\n');
          answer += delta.content;
          process.stdout.write(delta.content);
        }
        if (e.usage?.cost !== undefined) cost = e.usage.cost;
      }
      messages.push({ role: 'assistant', content: answer });
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      console.log(dim(`\n\n${cost !== undefined ? `$${cost.toFixed(5)} · ` : ''}${secs}s · ${last.requestId}`));
    }
    rl.close();
    store.close();
  });

program
  .command('route')
  .description('Show which model and effort a prompt would be routed to, and why (does not run it)')
  .argument('[prompt...]', 'the prompt')
  .option('-f, --file <path>', 'read the prompt from a file')
  .option('-m, --mode <mode>', 'cheap | balanced | best', parseMode, config.defaultMode)
  .option('--no-escalation', 'never escalate')
  .option('--json', 'print the raw decision')
  .option('--pref <key=value>', 'preference (repeatable): quality=N cost=N speed=N open=any|prefer|only prefer=a,b avoid=a,b min=N', parsePref, {})
  .action(async (words: string[], opts: { file?: string; mode: Mode; escalation: boolean; json?: boolean; pref: Partial<Preferences> }) => {
    const prompt = opts.file ? readFileSync(opts.file, 'utf8') : words.join(' ');
    if (!prompt.trim()) throw new InvalidArgumentError('provide a prompt or --file');
    warnMissingKeys();
    const store = new Store(config.dbPath);
    try {
      const decision = await new Router(store).route(
        { messages: [{ role: 'user', content: prompt }] },
        { mode: opts.mode, escalation: opts.escalation ? 'auto' : 'off', preferences: opts.pref },
      );
      console.log(opts.json ? JSON.stringify(decision, null, 2) : explainDecision(decision));
    } finally {
      store.close();
    }
  });

program
  .command('bench <file>')
  .description('Route a prompt set (text lines or JSONL cases) in each mode, flag suspicious routes, save results; no model is called')
  .option('--modes <modes...>', 'modes to compare', ['cheap', 'balanced', 'best'])
  .option('--out <file>', 'results JSONL', `bench/results/${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jsonl`)
  .option('--quiet', 'only print flagged routes and the summary')
  .option('--pref <key=value>', 'preference (repeatable): quality=N cost=N speed=N open=any|prefer|only prefer=a,b avoid=a,b min=N', parsePref, {})
  .action(async (file: string, opts: { modes: string[]; out: string; quiet?: boolean; pref: Partial<Preferences> }) => {
    const modes = opts.modes.map(parseMode);
    warnMissingKeys();
    const store = new Store(config.dbPath);
    let lastHeader = '';
    const rows = await runBench(store, loadCases(file), modes, opts.pref, (c, r) => {
      if (opts.quiet && !r.flags.length) return;
      if (lastHeader !== c.id && (lastHeader = c.id)) console.log(`\n${c.id} [${c.cat}${c.expect ? `, expect ${c.expect}` : ''}] ${c.prompt.length > 90 ? `${c.prompt.slice(0, 87)}...` : c.prompt}`);
      const needs = Object.entries(r.needs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ');
      console.log(
        `  ${r.mode.padEnd(8)} ${`${r.model} (${r.effort})`.padEnd(46)} P${(r.pSuccess * 100).toFixed(0).padStart(3)}% $${r.costUsd.toFixed(4).padStart(7)} ${r.latencyS.toFixed(1).padStart(5)}s${r.web ? ' web' : ''} | ${r.taskType} d${r.difficulty} | ${needs}`,
      );
      for (const f of r.flags) console.log(red(`           ⚑ ${f}`));
    });
    writeRows(opts.out, rows);
    console.log(`\n${summarize(rows)}\nresults: ${opts.out}`);
    store.close();
  });

program
  .command('serve')
  .description('Start the OpenAI-compatible gateway (model: "auto", "auto:cheap", "auto:best")')
  .option('-p, --port <port>', 'port', parseNumber, config.port)
  .option('--host <host>', 'interface to bind', '127.0.0.1')
  .action((opts: { port: number; host: string }) => {
    warnMissingKeys();
    warnAppNotBuilt();
    const store = new Store(config.dbPath);
    const app = createApp(store, new Router(store));
    serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, (info) => {
      console.log(`Model Router gateway on http://${opts.host}:${info.port}/v1  (POST /chat/completions, /route, /feedback; GET /models)`);
      console.log(`Testing interface on http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${info.port}/`);
      if (!config.gatewayKey && opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
        console.log(red('Warning: ROUTER_API_KEY is not set and the gateway is reachable from the network.'));
      }
    });
  });

program
  .command('ui')
  .description('Start the gateway and open the testing interface in your browser')
  .option('-p, --port <port>', 'port', parseNumber, config.port)
  .action((opts: { port: number }) => {
    warnMissingKeys();
    warnAppNotBuilt();
    const store = new Store(config.dbPath);
    const app = createApp(store, new Router(store));
    serve({ fetch: app.fetch, port: opts.port, hostname: '127.0.0.1' }, (info) => {
      const url = `http://127.0.0.1:${info.port}/`;
      console.log(`Testing interface on ${url}  (Ctrl+C to stop)`);
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).on('error', () => {});
    });
  });

program
  .command('sync')
  .description('Refresh pricing, context and effort levels for tracked models from OpenRouter')
  .action(async () => {
    const store = new Store(config.dbPath);
    const report = await syncFromOpenRouter(store);
    console.log(`updated ${report.updated.length} models`);
    if (report.missing.length) console.log(red(`no longer on OpenRouter: ${report.missing.join(', ')}`));
    if (report.untracked.length) {
      console.log('\nRecent models from tracked providers with no benchmark data yet (they join on the next `mrouter ingest` once benchmarked; unusual names go in data/model-map.json):');
      for (const m of report.untracked.slice(0, 25)) console.log(`  ${m.created}  ${m.id}`);
    }
    store.close();
  });

program
  .command('ingest')
  .description('Steps 1-2: build the capability DB from Artificial Analysis, LMArena, vendor reports and OpenRouter live stats')
  .option('--cache', 'reuse cached downloads in data/cache/ instead of fetching')
  .option('--since <date>', 'only models released on or after this date', '2025-09-01')
  .option('--skip <sources...>', 'skip sources: lmarena vendor stats')
  .action(async (opts: { cache?: boolean; since: string; skip?: string[] }) => {
    const skip = new Set(opts.skip ?? []);
    const cacheDir = new URL('../../data/cache/', import.meta.url);
    mkdirSync(cacheDir, { recursive: true });
    const cached = async <T>(name: string, fetcher: () => Promise<T>): Promise<{ data: T; fetchedAt: string }> => {
      const file = new URL(name, cacheDir);
      if (opts.cache && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
      const out = { data: await fetcher(), fetchedAt: new Date().toISOString() };
      writeFileSync(file, JSON.stringify(out));
      return out;
    };

    const aa = await cached('aa-free.json', () => fetchAaModels());
    const or = await cached('openrouter-models.json', () => fetchModels());
    const resolver = new ModelResolver(or.data);
    const external: ExternalResult[] = [];
    if (!skip.has('vendor')) external.push(...loadVendorResults());
    if (!skip.has('lmarena')) {
      for (const [benchmark, path] of Object.entries(LMARENA_CATEGORIES)) {
        try {
          const ratings = await cached(`lmarena-${benchmark}.json`, () => fetchArenaCategory(path));
          const { results, unresolved } = arenaResults(benchmark, ratings.data, resolver, ratings.fetchedAt);
          external.push(...results);
          console.log(dim(`  LMArena ${path}: ${ratings.data.length} ratings, ${results.length} matched, ${unresolved.length} unmatched`));
        } catch (err) {
          console.log(red(`  LMArena ${path}: ${(err as Error).message}`));
        }
      }
    }

    const store = new Store(config.dbPath);
    const report = runPipeline(store, { aa: aa.data, or: or.data, external, fetchedAt: aa.fetchedAt, minRelease: opts.since });
    console.log(`Capability DB: ${report.models.length} models from ${report.aaVariants} Artificial Analysis variants + ${report.externalRows} LMArena/vendor results`);
    console.log(`  ${report.measuredVariants} model x effort variants measured, ${report.filledVariants} filled from the measured effort curve; ${report.benchmarksEquated} benchmarks on the common scale`);
    if (report.externalUnmatched) console.log(dim(`  ${report.externalUnmatched} external results skipped (model not tracked or effort not offered)`));
    if (report.disabled.length) console.log(`  disabled (no independent anchor): ${report.disabled.join(', ')}`);

    if (!skip.has('stats')) {
      let n = 0;
      await Promise.all(
        report.models.map(async (id) => {
          const s = await fetchProviderStats(id).catch(() => undefined);
          if (s) {
            store.setProviderStats(id, s);
            n++;
          }
        }),
      );
      console.log(`  live speed/uptime from OpenRouter for ${n} models`);
    }
    console.log(dim('Sources: Artificial Analysis (https://artificialanalysis.ai/), LMArena (https://arena.ai/), vendor release pages (data/vendor-benchmarks.json), OpenRouter.'));
    store.close();
  });

program
  .command('profiles')
  .description('Step 3: have a strong LLM write each model\'s profile; only models whose data changed are regenerated')
  .option('--force', 'regenerate every profile')
  .option('--model <ids...>', 'only these models')
  .action(async (opts: { force?: boolean; model?: string[] }) => {
    const store = new Store(config.dbPath);
    const run = await generateProfiles(store, { force: opts.force, only: opts.model });
    console.log(`generated ${run.generated.length}, unchanged ${run.unchanged}, failed ${run.failed.length} (writer: ${config.profileModel})`);
    for (const f of run.failed.slice(0, 10)) console.log(red(`  ${f.id}: ${f.error}`));
    store.close();
  });

const models = program.command('models').description('Inspect and manage the capability database');

const top = (m: ModelRecord) => m.efforts[m.efforts.length - 1]!;
const skillAt = (m: ModelRecord, effort: Effort, dim: Dimension) => m.variantSkills[effort]?.[dim] ?? m.skills[dim];

models
  .command('list', { isDefault: true })
  .option('--all', 'include disabled models')
  .option('--sort <capability>', `sort by a capability at top effort (${CAPABILITY_KEYS.join(', ')})`, 'reasoning')
  .action((opts: { all?: boolean; sort: Dimension }) => {
    const store = new Store(config.dbPath);
    const rows = store.listModels({ includeDisabled: opts.all }).map((m) => {
      const t = top(m);
      const v = (d: Dimension) => skillAt(m, t, d)?.skill;
      return {
        model: m.id,
        on: m.enabled ? 'yes' : 'no',
        [`${opts.sort}@top`]: v(opts.sort),
        'code gen': v('code_generation'),
        'computer use': v('computer_use'),
        writing: v('writing'),
        'long ctx': v('long_context'),
        'in $/M': +(m.pricing.inputPerTok * 1e6).toFixed(2),
        'out $/M': +(m.pricing.outputPerTok * 1e6).toFixed(2),
        'tok/s': Math.round(m.tps),
        efforts: m.efforts.join('/'),
      };
    });
    rows.sort((a, b) => ((b[`${opts.sort}@top`] as number) ?? 0) - ((a[`${opts.sort}@top`] as number) ?? 0));
    console.table(rows);
    store.close();
  });

models
  .command('show <id>')
  .description('Every capability at every effort level, with sources and trust')
  .action((id: string) => {
    const store = new Store(config.dbPath);
    const m = store.listModels({ includeDisabled: true }).find((x) => x.id === id);
    if (!m) {
      console.log(red(`unknown model ${id}`));
      return store.close();
    }
    console.log(`${m.id}  ${m.enabled ? '' : '(disabled)'}  $${(m.pricing.inputPerTok * 1e6).toFixed(2)} in / $${(m.pricing.outputPerTok * 1e6).toFixed(2)} out per 1M · context ${Math.round(m.contextLength / 1000)}K · inputs ${m.inputModalities.join('+')}`);
    if (m.profile) console.log(`\n${m.profile}\n`);
    const dims: Dimension[] = CAPABILITY_KEYS;
    console.table(
      Object.fromEntries(
        dims.map((d) => [
          d,
          Object.fromEntries(m.efforts.map((e) => {
            const s = skillAt(m, e, d);
            return [e, s ? `${s.skill.toFixed(0)}${s.source.includes('effort-curve') ? '*' : ''} (${s.trust.toFixed(2)})` : '-'];
          })),
        ]),
      ),
    );
    console.log(dim('skill (trust); * = effort level not measured, filled from the measured effort curve'));
    console.table(
      Object.fromEntries(
        m.efforts.map((e) => {
          const v = m.variantMetrics[e];
          return [e, { 'tok/s': v?.tps?.toFixed(0) ?? '-', 'ttft s': v?.ttftS?.toFixed(1) ?? '-', 'reasoning tok (ref)': v?.reasoningTokensRef ?? '-' }];
        }),
      ),
    );
    const bench = store.benchmarks(id);
    if (bench.length) {
      const byEffort: Record<string, Record<string, number>> = {};
      for (const b of bench) (byEffort[b.effort] ??= {})[b.benchmark.replace('artificial_analysis_', 'aa_')] = +b.value.toFixed(3);
      console.log('Raw benchmarks (Artificial Analysis):');
      console.table(byEffort);
    }
    store.close();
  });

for (const [name, enabled] of [['enable', true], ['disable', false]] as const) {
  models
    .command(`${name} <id>`)
    .description(`${name} a model for routing`)
    .action((id: string) => {
      const store = new Store(config.dbPath);
      console.log(store.setEnabled(id, enabled) ? `${name}d ${id}` : red(`unknown model ${id}`));
      store.close();
    });
}

program
  .command('feedback <requestId> <verdict> [comment...]')
  .description('Record whether a routed answer was good or bad (feeds the learning loop)')
  .action((requestId: string, verdict: string, comment: string[]) => {
    if (verdict !== 'good' && verdict !== 'bad') throw new InvalidArgumentError('verdict must be good or bad');
    const store = new Store(config.dbPath);
    const ok = store.recordFeedback(requestId, verdict === 'good', undefined, comment.join(' ') || undefined);
    console.log(ok ? 'recorded' : red(`unknown request ${requestId}`));
    store.close();
  });

program
  .command('calibrate')
  .description('Rebuild the learned estimate corrections (answer length, thinking, time) from all recorded answers')
  .action(() => {
    const store = new Store(config.dbPath);
    const { answers, models } = rebuildCalibration(store);
    console.log(`learned from ${answers} answers across ${models} models`);
    const LENGTHS = ['sentences', 'paragraphs', 'document', 'very long'];
    const byModel = new Map<string, string[]>();
    for (const r of store.calibrationRows()) {
      const factor = Math.exp(r.sum_log / (r.n + CALIBRATION_PRIOR));
      // Per-effort thinking and per-length answer factors are shown individually; the thinking '*' row is
      // only a fallback for efforts without their own data.
      if (r.metric === 'reasoning' && r.effort === '*') continue;
      const label =
        r.metric === 'reasoning' ? `thinking@${r.effort}`
        : r.metric === 'output' ? (r.effort === '*' ? 'answer length' : `answer length (${LENGTHS[Number(r.effort)] ?? r.effort})`)
        : r.metric === 'web' ? 'web overhead'
        : r.metric === 'input' ? 'prompt size'
        : 'time';
      byModel.set(r.model_id, [...(byModel.get(r.model_id) ?? []), `${label} x${factor.toFixed(2)} (n=${r.n})`]);
    }
    const all = byModel.get('*');
    byModel.delete('*');
    for (const [m, parts] of byModel) console.log(`  ${m.padEnd(34)} ${parts.join(' · ')}`);
    if (all) console.log(`  ${'(all models, fallback)'.padEnd(34)} ${all.join(' · ')}`);
    store.close();
  });

program
  .command('stats')
  .description('Requests, cost, latency and feedback per model')
  .action(() => {
    const store = new Store(config.dbPath);
    const rows = store.summary();
    if (rows.length) console.table(rows);
    else console.log('no requests yet');
    store.close();
  });

program
  .command('check')
  .description('Verify API keys and time a Jev classification')
  .action(async () => {
    let failed = false;
    if (!config.openRouterKey) {
      console.log(red('✗ OPENROUTER_API_KEY missing'));
      failed = true;
    } else {
      const res = await fetch(`${config.openRouterBaseUrl}/key`, { headers: { Authorization: `Bearer ${config.openRouterKey}` } });
      console.log(res.ok ? '✓ OpenRouter key valid' : red(`✗ OpenRouter key rejected (${res.status})`));
      failed ||= !res.ok;
    }
    if (!config.typesafeKey) {
      console.log(red('✗ TYPESAFE_API_KEY missing'));
      failed = true;
    } else {
      const req: ChatRequest = { messages: [{ role: 'user', content: 'Fix the off-by-one error in my binary search.' }] };
      try {
        const t = await classifyWithJev(buildJevState(req, extractFacts(req)));
        console.log(`✓ Jev answered in ${Math.round(t.latencyMs)}ms: ${t.taskType.value} (confidence ${t.taskType.confidence.toFixed(2)}), difficulty ${t.difficulty.value}`);
      } catch (err) {
        console.log(red(`✗ Jev call failed: ${(err as Error).message}`));
        failed = true;
      }
    }
    process.exitCode = failed ? 1 : 0;
  });

const service = program
  .command('service')
  .description('Run the router in the background on macOS: starts at login, restarts after crashes and code changes');
const portOpt = ['-p, --port <port>', 'port', parseNumber, config.port] as const;
service
  .command('install')
  .description('Install and start the background service')
  .option(...portOpt)
  .action((opts: { port: number }) => installService(opts.port));
service.command('uninstall').description('Stop and remove the background service').action(() => uninstallService());
service.command('start').description('Start the installed service').option(...portOpt).action((opts: { port: number }) => startService(opts.port));
service.command('stop').description('Stop the service until the next login').action(() => stopService());
service
  .command('restart')
  .description('Restart the service (needed after installing new npm packages)')
  .option(...portOpt)
  .action((opts: { port: number }) => restartService(opts.port));
service.command('status').description('Is it installed, running and answering?').option(...portOpt).action((opts: { port: number }) => printStatus(opts.port));
service
  .command('logs')
  .description('Show the service log')
  .option('-n, --lines <n>', 'lines', parseNumber, 60)
  .option('-f, --follow', 'keep following')
  .action((opts: { lines: number; follow?: boolean }) => showLogs(opts.lines, Boolean(opts.follow)));

program.parseAsync().catch((err: unknown) => {
  console.error(red(err instanceof RoutingError ? err.message : ((err as Error).stack ?? String(err))));
  process.exitCode = 1;
});
