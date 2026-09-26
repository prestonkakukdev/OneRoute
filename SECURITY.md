# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through GitHub:
**Security → Report a vulnerability** on this repository. You'll get a reply within a few days.

## How System1 Route handles secrets and data

- API keys live only in your local `.env` (git-ignored) and are sent only to the services they belong to
  (OpenRouter, TypeSafe/Jev, and optionally Artificial Analysis).
- By default the router listens on `127.0.0.1` only. If you expose it on a network (`--host 0.0.0.0`), set
  `ROUTER_API_KEY` so every request to the API and the app needs `Authorization: Bearer <key>`.
- Chats, attachments and the routing log are stored locally in `router.db`. Anyone with access to that file can read
  them.
- Model answers are rendered as sanitized HTML (DOMPurify) in the app.
