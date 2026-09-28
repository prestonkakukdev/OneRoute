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
