# System1 Route

[![CI](https://github.com/prestonkakukdev/System1-Route/actions/workflows/ci.yml/badge.svg)](https://github.com/prestonkakukdev/System1-Route/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Routes every request to the best model and reasoning effort for the job, so you get frontier answers when they
matter and fast, cheap ones when they don't.

**Jev** (TypeSafe's System One model) reads each request and answers ~20 quick questions about it: task type,
difficulty, how much reasoning it needs, whether it needs the web, which capabilities matter. **Plain code** then
scores every model × effort against a capability database built from independent benchmarks and picks the best
`P(success) × value − cost − waiting`. Every decision is explained.

```
request ─► Jev (one call, ~0.5s): task type, difficulty, reasoning depth, output length, needs web,
           latency-sensitive, high stakes, + importance (0-1) of 11 capabilities
        ─► requirement profile: weights over 16 capabilities (task-type mix + Jev importances + hard facts)
        ─► hard filters (context, images, tools, JSON schema, allow/deny, cost/latency caps)
        ─► score every model × effort against the capability DB (weakest required capability dominates)
        ─► escalate to an LLM only if Jev is unsure or the top two are tied
        ─► call the model through OpenRouter (fallbacks, caching) ─► log cost, latency, feedback ─► learn
```

**What you get**
- A chat app (web, installable in the macOS Dock) that shows, for every answer, which model and effort were picked and why
- An OpenAI-compatible API (`model: "auto"`), so existing tools and SDKs can use the router unchanged
- A CLI for chatting, inspecting decisions and managing the model database
- ~110 current models with per-effort capability scores, speed and pricing, shipped in `data/catalog.json`
- Learning from use: estimates self-correct from real answers; "that's wrong" in your next message counts as feedback

## Quick start

You need **Node.js 22.13 or newer**, an **[OpenRouter](https://openrouter.ai/keys) API key with some credits** (it runs
the models) and a **Jev / [TypeSafe](https://typesafe.ai) API key** (it reads the requests).

```bash
git clone https://github.com/prestonkakukdev/model-router.git
cd model-router
npm install
npm run setup      # asks for your two keys, builds everything and checks the keys work
npm start          # then open http://localhost:8787
```

`npm run setup` writes your keys to `.env` (git-ignored). You can also copy `.env.example` to `.env` and fill it in
by hand; the optional settings are documented there.

**Keep it running (macOS).** Instead of `npm start`:

```bash
npm run service -- install   # background service: starts at login, restarts itself after crashes and updates
```

Then open http://localhost:8787 in Safari and choose **File → Add to Dock** (Chrome: ⋮ → Cast, save and share →
Install page as app) to get it as its own app. On Linux or Windows, run `npm start` under your usual process manager.

**Use it from code.** Point any OpenAI-compatible client at `http://localhost:8787/v1` with model `auto` (see [API](#api)).

**Put `mrouter` on your PATH** (optional): `npm link`. Otherwise use `npm run dev -- <command>`.

### Updating

```bash
git pull && npm install && npm run build
```

A newer model catalog in `data/catalog.json` is loaded automatically on the next start (models you disabled stay
disabled). With the background service, code changes go live by themselves; run `npm run service -- restart` after
`npm install`.

### What stays on your machine

Everything is local: your keys (`.env`), your chats, attachments, routing log, feedback and the corrections the router
learns from your usage all live in `router.db` next to the code. Nothing is sent anywhere except the requests
themselves: to Jev (a compact summary of the conversation, to classify it) and to OpenRouter (the conversation, to the
chosen model). Set `ROUTER_STORE_PROMPTS=false` to keep prompt text out of the routing log.

## The app

```bash
mrouter ui          # starts the router and opens http://127.0.0.1:8787/ (skip if the service is running)
```

**Keep it running (macOS):**

```bash
npm run service -- install   # background service: starts at login, restarts after crashes
npm run service -- status    # installed / running / answering
npm run service -- logs -f   # follow ~/Library/Logs/ModelRouter/service.log
npm run service -- restart   # after `npm install` (new packages)
npm run service -- stop      # until next login;  uninstall  removes it
```

The service (a launchd agent, `com.modelrouter.service`) runs `scripts/service.mjs`, which restarts the router when
it crashes (backoff up to 30s) or when `src/`, `data/`, `.env` or `package.json` change, and rebuilds the app when
`web/` changes. So edits and `git pull`s go live on their own; only new npm packages need `service restart`.

**Put it in the Dock:** open http://localhost:8787 in Safari and choose File → Add to Dock (or in Chrome: ⋮ →
Cast, save and share → Install page as app). It opens in its own window with its own icon; the router must be running.

Chats are saved in the router's database (`router.db`, tables `chats` and `chat_turns`, attachments included) and
listed in the left sidebar, where you can reopen, rename or delete them; the address bar keeps the open chat, so a
refresh brings you back to it. Every answer has a Copy button (and each code block its own). Both sidebars collapse
from the header buttons.

The interface is React + TypeScript + Tailwind v4 in `web/`, laid out the shadcn way (`web/src/components/ui`,
`@/` alias, `web/components.json`). The composer is the Motoko `AiPromptInput` component
(`web/src/components/ui/ai-prompt-input.tsx`); the routing modes use its model selector. The router reads the built
files on every request, so after `npm run web:build` a refresh shows the change without restarting. For live reload
while editing the interface, run `npm run web:dev` next to a running router and open http://localhost:5173.

Chat on the left. Click any answer to inspect it on the right: Jev's reading (task type, difficulty,
reasoning depth, answer length, signals, capability importance), the capability weights the router looked for,
a plain-English "why this model", the top candidates with a score breakdown (value and quality vs cost, time and
preference penalties), models ruled out, and the actual cost and time once the answer finishes. Rate answers with 👍/👎
(this feeds the learning loop). Tick **Route only** to test routing without calling a model.

**Attachments:** click the paperclip, or drop or paste files into the chat. Supported: images (PNG, JPEG, WebP, GIF;
large photos are scaled down to 2048px first), PDFs (up to 20 MB) and any text or code file (up to 1 MB, sent inline so
every model can read it). Attachments stay in the conversation, so follow-up questions can refer to them.

## Use it

```bash
mrouter chat                      # terminal chat; each turn is routed. /why /good /bad /mode best
mrouter route "fix this race condition in my Go worker pool"   # show the decision without running it
mrouter serve                     # OpenAI-compatible gateway on http://127.0.0.1:8787/v1
mrouter models                    # the capability database
mrouter stats                     # requests, cost, latency, feedback per model
```

### API

Any OpenAI-compatible client works. Set the model to `auto`, `auto:cheap`, `auto:balanced` or `auto:best`.
Any other model id is passed straight through with no routing.

```bash
curl http://127.0.0.1:8787/v1/chat/completions -H 'content-type: application/json' -d '{
  "model": "auto",
  "messages": [{"role": "user", "content": "Write a SQL query for monthly active users"}],
  "router": {"max_cost_usd": 0.05, "session_id": "my-chat-1"}
}'
```

```ts
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: process.env.ROUTER_API_KEY ?? 'unused' });
const res = await client.chat.completions.create({ model: 'auto:best', messages: [{ role: 'user', content: 'Prove that √2 is irrational' }] });
```

| Endpoint | Purpose |
|---|---|
| `POST /v1/chat/completions` | Route and run (streaming supported). The response carries a `router` object and `x-router-*` headers. |
| `POST /v1/route` | The decision only: model, effort, Jev's answers and the ranked candidates. Nothing is run. |
| `POST /v1/feedback` | `{"request_id", "success": true/false}`. Feeds the learning loop. |
| `GET /v1/models` | `auto*` plus every tracked model. |

Optional `router` fields: `mode`, `max_cost_usd`, `max_latency_s`, `allow_models`, `deny_models`,
`web` (`auto`/`on`/`off`), `escalation` (`auto`/`off`), `session_id` (keeps a conversation on one model, so its prompt cache is reused).
Set `ROUTER_API_KEY` to require a bearer token.

Attachments use the OpenAI content-part format: `{"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}`
and `{"type": "file", "file": {"filename": "report.pdf", "file_data": "data:application/pdf;base64,..."}}`. Images
only go to models that accept images. PDFs go to any model: models that read PDFs natively see the pages (text, figures
and scans); for the rest, the router asks OpenRouter to extract the text for free (OpenRouter's default would be paid OCR)
and scores them slightly lower. Prompt size is estimated from the actual image dimensions and PDF page counts.

## How the pieces fit

| Path | What it does |
|---|---|
| `src/taxonomy.ts` | The shared vocabulary (task types, difficulty levels, effort ladder) plus every tuning constant. |
| `src/classifier/` | Builds a compact request summary for Jev (well under its 32K limit), asks the questions, and falls back to keywords if Jev is down. |
| `src/db/` | SQLite capability DB: models, skills per model × task type (× effort once measured), decisions, outcomes, sessions. |
| `src/router/` | The estimator (success, tokens, cost, latency), the optimizer, escalation, and the explanations. |
| `src/gateway/` | Executes against OpenRouter with fallbacks, passes streams through, and records usage. Also the HTTP server. |
| `web/` | The app: React + TypeScript + Tailwind v4 (shadcn layout), built to `web/dist` and served by the router. |
| `scripts/` | `setup.mjs` (first-time setup) and `service.mjs` (the background-service supervisor). |
| `data/` | `catalog.json` (the shipped model database), vendor benchmark reports, name mappings, and bootstrap priors. |

## Preferences

Modes (`cheap` / `balanced` / `best`) set the baseline; preferences steer the optimizer on top of that.

| Preference | Effect |
|---|---|
| `quality_weight` (default 1) | How much answer quality counts. >1 = pay more for a better answer ("sacrifice cost for intelligence") |
| `cost_weight` (default 1) | How much saving money counts. <1 = cost matters less (stronger, pricier models are fine); >1 = more cost-conscious |
| `speed_weight` (default 1) | How much waiting counts. >1 = prefer faster models and lower effort |
| `open_weights` | `any`, `prefer` (closed models must clearly win), `only` (closed models excluded) |
| `prefer_providers`, `avoid_providers` | Soft preference, e.g. `["anthropic","google"]` |
| `min_quality` (0-100) | Never pick a model whose skill for the request is below this |

Weights multiply how much each factor counts in the score: 0.5 = half as much, 2 = twice as much. The app shows
them as plain choices (Doesn't matter much / Matters less / Normal / Matters more / Matters a lot).

```bash
mrouter chat --pref quality=3 --pref open=prefer --pref avoid=x-ai
```
```json
// mrouter.config.json (your defaults)
{ "mode": "balanced", "preferences": { "qualityWeight": 2, "openWeights": "prefer" } }
```
Per request (API): `"router": { "preferences": { "quality_weight": 3, "open_weights": "only" } }`.

Always on: a success is worth more for bigger jobs (input size), answer quality counts even when every model would
"pass" (so a greeting goes to a fast, well-liked model rather than the weakest one), and live reliability only counts
once a model has a real traffic record on OpenRouter.

## The capability database (steps 1-3)

The repo ships the database as `data/catalog.json`, so you don't need to build it. To rebuild it from the sources
yourself (needs a free [Artificial Analysis](https://artificialanalysis.ai) API key in `ARTIFICIAL_ANALYSIS_API_KEY`):

```bash
mrouter ingest               # steps 1-2: rebuild from all sources (~20s); --cache reuses downloads
mrouter catalog export       # write the result to data/catalog.json (to share it, e.g. in a pull request)
mrouter profiles             # step 3: a strong LLM writes each model's profile (only changed models)
mrouter models list --sort computer_use
mrouter models show anthropic/claude-opus-5.5   # every capability at every effort, with trust and sources
```

**Sources** (every raw number is kept in `benchmark_results` with its source, date and whether it is independent):

| Source | What it adds |
|---|---|
| Artificial Analysis (free API) | Intelligence/coding/math indexes, GPQA, HLE, SciCode, long-context (LCR), Terminal-Bench, τ²-Bench, IFBench, LiveCodeBench, AIME, MMLU-Pro — measured **per reasoning effort**; speed and thinking time per effort |
| LMArena | Blind human-preference Elo overall and for creative writing, instruction following, coding, math, hard prompts (independent) |
| Vendor release pages (`data/vendor-benchmarks.json`) | OSWorld, ScreenSpot-Pro (computer use), BrowseComp (web research), Terminal-Bench 4.0, DeepSWE, FrontierCode, CursorBench, GDPval, AutomationBench, MRCR, CharXiv, ARC-AGI, … Weighted at 0.6 of an independent result |
| OpenRouter | Live pricing, context, modalities, effort levels; live median speed and uptime across providers |

**How numbers become capabilities**
- Each benchmark is linearly equated onto the Intelligence Index scale (AA benchmarks over ~670 AA variants,
  others over the tracked models that report both).
- Each of 16 capabilities (`CAPABILITIES` in `src/taxonomy.ts`) blends the benchmarks that measure it
  (`DIMENSION_BENCHMARKS`). The model's overall index is a weak prior (`INDEX_PRIOR_WEIGHT`); each benchmark adds
  evidence = relevance × source quality × equating reliability. `trust` says how much real evidence there is.
- **Effort levels**: measured where tested. Otherwise the strongest evidence from another effort is moved along the
  effort curve, scaled by the model's **own** measured index drop between those efforts when AA tested both.
- Add vendor numbers by appending a report to `data/vendor-benchmarks.json`; add name mappings in `data/model-map.json`.
- Known gaps: vision and web research rest mostly on vendor numbers; no hallucination-rate source (AA's is Pro-only).

## Tuning

All knobs live in `src/taxonomy.ts` (and a few in `src/config.ts` / `.env`):

| Knob | Meaning |
|---|---|
| `DIFFICULTY_THRESHOLDS`, `SUCCESS_CURVE_WIDTH`, `INDEX_TO_SKILL` | Skill needed for a 50% chance at each difficulty — **provisional; calibrate with evals** |
| `MODE_WEIGHTS`, `DIFFICULTY_VALUE` | What a success is worth and what a second costs, per mode |
| `TASK_CAPABILITY_MIX`, `DIMENSION_BENCHMARKS` | What each task type needs; which benchmarks measure each capability |
| `CAPABILITY_MEAN_EXPONENT` | How strongly the weakest required capability dominates (more negative = stricter) |
| `QUALITY_FLOOR_RATIO` | Never pick a candidate far below the best achievable success chance |
| `ROUTER_MIN_TASK_CONFIDENCE`, `ROUTER_TIE_MARGIN` | When to escalate |

```bash
mrouter bench bench/sample.txt           # route a prompt set in every mode; no model is called
mrouter route --json "..."               # full decision, including Jev's raw answers and all candidates
```

## Development

```bash
npm test               # unit tests (offline; no keys needed)
npm run typecheck      # router and app
npm run web:dev        # live-reloading app on http://localhost:5173 (next to a running router)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## Data sources and attribution

Capability scores are derived from [Artificial Analysis](https://artificialanalysis.ai) (benchmarks and speed per
reasoning effort), [LMArena](https://lmarena.ai) (human-preference ratings), vendor model cards and release pages, and
[OpenRouter](https://openrouter.ai) (pricing, context, modalities and live provider stats). The catalog contains the
router's derived scores, not the sources' raw datasets. Model routing and classification use
[TypeSafe's Jev](https://typesafe.ai).

## License

[Apache License 2.0](LICENSE). Copyright 2026 prestonkakukdev.
