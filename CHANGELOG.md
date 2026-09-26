# Changelog

## Unreleased

- Renamed the project from Model Router to System1 Route: the CLI is now `s1route`, the macOS service
  `com.system1route.service` (installing replaces the old agent), logs in `~/Library/Logs/System1Route/`.

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
