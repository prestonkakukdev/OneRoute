# Changelog

## Unreleased

- **OneRoute Code**: a Code mode next to Chat, where a coding agent builds, edits, runs and tests projects in folders on
  your computer, with every run routed by OneRoute.
  - Opens folders with Finder's chooser; works directly in the folder with a checkpoint per message ("Restore files
    to here", "Undo changes"), or on a separate git branch in its own worktree.
  - Auto-edit / Ask / Plan permissions; dangerous commands always ask, with a system notification when the app isn't
    in view.
  - Checks its own work: the project's tests, type check and lint, plus a headless-Chrome check of web pages, run when
    the agent finishes; failures go back to it, and the result feeds the router's learning.
  - Explorer and reviewer helpers in their own context, routed separately (reviewers from a different model family).
  - Project memory learned from corrections and failures, editable in the app.
  - Preview (dev server or static server), background processes, context compaction, retries when a model's
    connection drops, and Resume / Retry for runs stopped by a restart or an error.
  - Web research: `web_search` (cited sources) and `web_fetch` tools, also for the explorer helper.
  - Cost safety: per-step output caps, effort caps for expensive models, and a time-based thinking watchdog; a step
    that only thinks is stopped and retried at low effort instead of being shown as "answered". Stop works
    mid-stream, and the service no longer restarts while a run is active.
  - Verification opens the pages a run changed, not just the project's root `index.html`.
- Models: GPT-6.1 Sol and Terra, Claude Haiku 5.5, Gemini 4 Argon, Kimi K3.1 Pro, Muse Wonder, DeepSeek V4.1 Flash
  1017, DeepSeek V4 Pro 0813, Mistral Large 4, Step 5 Preview, Beam 1.0 and others (122 enabled models). Vendor
  results from the GPT-6.1 Terra and Sol pages (every effort level), the Claude Haiku 5.5 and Sonnet 5.5 pages, and
  AA-Briefcase / AA-Omniscience.
- Artificial Analysis Intelligence Index v5: the capability scale stays on the v4 series (`data/aa-index-v4.json`);
  v5 is an ordinary benchmark and models AA has not scored on v4 get an estimate from v5 and their other benchmarks
  (mean error 2.1 points, leave-one-out). Without this, an ingest would have dropped from 115 models to 33.
- Ingest keeps a source's last download when it fails (LMArena now blocks automated requests).
- Renamed the project to OneRoute (earlier: Model Router, then System1 Route): the CLI is now `oneroute`,
  the macOS service `com.oneroute.service` (installing replaces older agents), logs in `~/Library/Logs/OneRoute/`.

## 0.1.0 (2026-09-26)

First public release.

- Routing: Jev classifies each request; a deterministic optimizer picks the model and reasoning effort from a
  capability database (16 capabilities, per effort) built from Artificial Analysis, LMArena, vendor reports and
  OpenRouter. Escalates to an LLM only when unsure.
- OpenAI-compatible gateway (`model: "auto"`), streaming, fallbacks, prompt caching with conversation stickiness,
  web search when needed, attachments (images, PDFs, text files).
- Learning: success rates from feedback, feedback inferred from follow-up messages, and cost/length/speed estimates
  that correct themselves from real answers.
- App: chat with a routing inspector, saved chats, copy buttons, Markdown/math rendering, installable in the macOS Dock.
- macOS background service (`npm run service -- install`) and one-command setup (`npm run setup`).
- Ships the model database as `data/catalog.json`, loaded automatically on first start.
