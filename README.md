# Model Router

Routes every request to the best model and reasoning effort for the job.
**Jev** (TypeSafe's System One model) reads the request and answers 18 quick questions about it.
**Plain code** combines those answers with the capability database and picks the model × effort with the best
`P(success) × value − cost − latency penalty`.

```
request ─► Jev (one call, ~0.3-1s): task type, difficulty, reasoning depth, output length, needs web,
           latency-sensitive, high stakes, + importance (0-1) of 11 capabilities
        ─► requirement profile: weights over 16 capabilities (task-type mix + Jev importances + hard facts)
        ─► hard filters (context, images, tools, JSON schema, allow/deny, cost/latency caps)
        ─► score every model × effort against the capability DB (weakest required capability dominates)
        ─► escalate to an LLM only if Jev is unsure or the top two are tied
        ─► call the model through OpenRouter (fallbacks, caching) ─► log cost, latency, feedback ─► learn
```

## Setup

Requires Node 22.13+.

```bash
npm install
npm run build
npm link            # optional: puts `mrouter` on your PATH
```

Put your keys in `.env` (`OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, `ARTIFICIAL_ANALYSIS_API_KEY`), then:

```bash
mrouter check       # verifies the keys and times a Jev call
mrouter ingest      # builds the capability database (needs ARTIFICIAL_ANALYSIS_API_KEY)
mrouter profiles    # optional: LLM-written model profiles (needs OpenRouter credits, ~$1-2)
```

Without `npm link`, use `npm run dev -- <command>` or `node dist/cli/index.js <command>`.

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

## How the pieces fit

| Path | What it does |
|---|---|
| `src/taxonomy.ts` | The shared vocabulary (task types, difficulty levels, effort ladder) plus every tuning constant. |
| `src/classifier/` | Builds a compact request summary for Jev (well under its 32K limit), asks the questions, and falls back to keywords if Jev is down. |
| `src/db/` | SQLite capability DB: models, skills per model × task type (× effort once measured), decisions, outcomes, sessions. |
| `src/router/` | The estimator (success, tokens, cost, latency), the optimizer, escalation, and the explanations. |
| `src/gateway/` | Executes against OpenRouter with fallbacks, passes streams through, and records usage. Also the HTTP server. |
| `data/` | Seed priors (`seed.json`) and an OpenRouter metadata snapshot, so it works before the first `sync`. |

## Preferences

Modes (`cheap` / `balanced` / `best`) set the baseline; preferences steer the optimizer on top of that.

| Preference | Effect |
|---|---|
| `quality_weight` (default 1) | >1 = pay more for a better answer ("sacrifice cost for intelligence") |
| `cost_weight`, `speed_weight` | >1 = more cost-conscious / more impatient |
| `open_weights` | `any`, `prefer` (closed models must clearly win), `only` (closed models excluded) |
| `prefer_providers`, `avoid_providers` | Soft preference, e.g. `["anthropic","google"]` |
| `min_quality` (0-100) | Never pick a model whose skill for the request is below this |

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

```bash
mrouter ingest               # steps 1-2: rebuild from all sources (~20s); --cache reuses downloads
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

## Tests

```bash
npm test
```
