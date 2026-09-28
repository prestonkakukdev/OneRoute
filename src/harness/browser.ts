// Checks a web page in a real (headless) browser: loads it, optionally clicks and types, and reports what a person
// would hit — console errors, uncaught exceptions, failed requests — plus the visible text and a screenshot.
//
// Uses the Google Chrome installed on this computer (or Playwright's Chromium if that is installed). The browser is
// started on first use and closed again after a minute idle.

import type { Browser } from 'playwright-core';

export type PageStep =
  | { action: 'click'; selector: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'press'; key: string; selector?: string }
  | { action: 'select'; selector: string; value: string }
  | { action: 'wait'; ms: number };

export interface PageCheck {
  url: string;
  title: string;
  status?: number;
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
  failedRequests: string[];
  stepResults: string[];
  reads: Record<string, string>;
  text: string;
  screenshot?: string; // file path
  problems: number; // console errors + page errors + failed requests + failed steps
}

let browser: Promise<Browser> | undefined;
let idle: NodeJS.Timeout | undefined;

async function launch(): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  const attempts: (() => Promise<Browser>)[] = [
    ...(process.env.ONEROUTE_BROWSER ? [() => chromium.launch({ executablePath: process.env.ONEROUTE_BROWSER, headless: true })] : []),
    () => chromium.launch({ channel: 'chrome', headless: true }),
    () => chromium.launch({ headless: true }),
    () => chromium.launch({ channel: 'msedge', headless: true }),
  ];
  let last: unknown;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`No browser available for page checks. Install Google Chrome, or set ONEROUTE_BROWSER to a Chromium executable. (${(last as Error)?.message?.split('\n')[0] ?? ''})`);
}

async function getBrowser(): Promise<Browser> {
  if (idle) clearTimeout(idle);
  browser ??= launch().catch((err) => {
    browser = undefined;
    throw err;
  });
  const b = await browser;
  if (!b.isConnected()) {
    browser = undefined;
    return getBrowser();
  }
  return b;
}

function scheduleClose(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    const b = browser;
    browser = undefined;
    void b?.then((x) => x.close()).catch(() => {});
  }, 60_000);
  idle.unref();
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function checkPage(opts: { url: string; steps?: PageStep[]; read?: string[]; screenshotPath?: string; viewport?: { width: number; height: number }; signal?: AbortSignal }): Promise<PageCheck> {
  const b = await getBrowser();
  const context = await b.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 } });
  const page = await context.newPage();
  const abort = () => void context.close().catch(() => {});
  opts.signal?.addEventListener('abort', abort, { once: true });
  const result: PageCheck = { url: opts.url, title: '', consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [], stepResults: [], reads: {}, text: '', problems: 0 };
  page.on('console', (m) => {
    const where = m.location()?.url ? ` (${m.location().url.split('/').pop()}:${m.location().lineNumber + 1})` : '';
    if (m.type() === 'error') result.consoleErrors.push(clip(m.text(), 500) + where);
    else if (m.type() === 'warning') result.consoleWarnings.push(clip(m.text(), 300) + where);
  });
  page.on('pageerror', (err) => result.pageErrors.push(clip(err.stack || err.message, 800)));
  page.on('requestfailed', (r) => result.failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText ?? 'failed'}`));
  page.on('response', (r) => {
    if (r.status() >= 400) result.failedRequests.push(`${r.request().method()} ${r.url()} — HTTP ${r.status()}`);
  });
  try {
    const res = await page.goto(opts.url, { waitUntil: 'load', timeout: 20_000 });
    result.status = res?.status();
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    for (const step of opts.steps ?? []) {
      try {
        if (step.action === 'click') await page.click(step.selector, { timeout: 5000 });
        else if (step.action === 'fill') await page.fill(step.selector, step.value, { timeout: 5000 });
        else if (step.action === 'select') await page.selectOption(step.selector, step.value, { timeout: 5000 });
        else if (step.action === 'press') await (step.selector ? page.press(step.selector, step.key, { timeout: 5000 }) : page.keyboard.press(step.key));
        else await page.waitForTimeout(Math.min(step.ms, 10_000));
        result.stepResults.push(`ok: ${describeStep(step)}`);
      } catch (err) {
        result.stepResults.push(`FAILED: ${describeStep(step)} — ${clip((err as Error).message.split('\n')[0] ?? '', 300)}`);
      }
    }
    if (opts.steps?.length) await page.waitForTimeout(250);
    result.title = await page.title();
    for (const sel of opts.read ?? []) {
      const el = page.locator(sel).first();
      result.reads[sel] = (await el.count()) ? clip((await el.innerText({ timeout: 2000 }).catch(async () => (await el.inputValue().catch(() => '')) || '')).trim(), 500) : '(no element matches)';
    }
    result.text = clip(((await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')) || '').replace(/\n{3,}/g, '\n\n').trim(), 3000);
    if (opts.screenshotPath) {
      await page.screenshot({ path: opts.screenshotPath, type: 'jpeg', quality: 70 });
      result.screenshot = opts.screenshotPath;
    }
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    await context.close().catch(() => {});
    scheduleClose();
  }
  result.problems = result.consoleErrors.length + result.pageErrors.length + result.failedRequests.length + result.stepResults.filter((s) => s.startsWith('FAILED')).length;
  return result;
}

function describeStep(s: PageStep): string {
  if (s.action === 'fill') return `fill ${s.selector} with ${JSON.stringify(s.value)}`;
  if (s.action === 'select') return `select ${JSON.stringify(s.value)} in ${s.selector}`;
  if (s.action === 'press') return `press ${s.key}${s.selector ? ` in ${s.selector}` : ''}`;
  if (s.action === 'wait') return `wait ${s.ms}ms`;
  return `click ${s.selector}`;
}

// The report the agent reads.
export function formatPageCheck(r: PageCheck): string {
  const lines = [`Loaded ${r.url}${r.status ? ` (HTTP ${r.status})` : ''} — title: ${r.title || '(none)'}`];
  lines.push(r.problems ? `${r.problems} problem${r.problems > 1 ? 's' : ''} found.` : 'No console errors, exceptions or failed requests.');
  if (r.pageErrors.length) lines.push('', 'Uncaught exceptions:', ...r.pageErrors.map((e) => `- ${e}`));
  if (r.consoleErrors.length) lines.push('', 'Console errors:', ...r.consoleErrors.slice(0, 20).map((e) => `- ${e}`));
  if (r.failedRequests.length) lines.push('', 'Failed requests:', ...r.failedRequests.slice(0, 20).map((e) => `- ${e}`));
  if (r.stepResults.length) lines.push('', 'Steps:', ...r.stepResults.map((e) => `- ${e}`));
  if (Object.keys(r.reads).length) lines.push('', 'Read:', ...Object.entries(r.reads).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`));
  if (r.consoleWarnings.length) lines.push('', 'Console warnings:', ...r.consoleWarnings.slice(0, 8).map((e) => `- ${e}`));
  lines.push('', 'Visible text:', r.text || '(empty page)');
  return lines.join('\n');
}
