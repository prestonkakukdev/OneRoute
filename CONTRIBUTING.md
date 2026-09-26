# Contributing

Thanks for helping improve OneRoute. Issues and pull requests are welcome.

## Getting set up

```bash
git clone https://github.com/prestonkakukdev/OneRoute.git
cd OneRoute
npm install
npm run setup        # keys are only needed to run the router, not for tests
```

Useful commands:

| Command | What it does |
|---|---|
| `npm test` | Unit tests. Offline and key-free: the LLM, Jev and OpenRouter calls are mocked. |
| `npm run typecheck` | Type-checks the router (`src/`) and the app (`web/`). |
| `npm run build` | Builds the router (`dist/`) and the app (`web/dist/`). |
| `npm run web:dev` | Live-reloading app on http://localhost:5173 (needs a router running on 8787). |
| `npm run dev -- <command>` | Runs the CLI from source, e.g. `npm run dev -- route "hello"`. |

## Pull requests

- Keep changes focused; one topic per pull request.
- Add or update tests for behaviour changes (`test/`), and keep `npm test` and `npm run typecheck` green; CI runs both.
- Match the surrounding code: TypeScript, small functions, comments that explain *why*.
- Never commit secrets. `.env`, `router.db` and downloaded source data are git-ignored; keep it that way.

### Routing and capability data

- Routing constants live in `src/taxonomy.ts`. If you change them, run `npm run dev -- bench bench/stage0.jsonl` before
  and after and describe the difference in the pull request.
- New vendor benchmark numbers go in `data/vendor-benchmarks.json` (with the source URL); model name mappings in
  `data/model-map.json`.
- To update the shipped model database, run `oneroute ingest` (needs a free Artificial Analysis key) and then
  `oneroute catalog export`, and commit `data/catalog.json`.

## Reporting bugs

Open an issue with what you did, what you expected and what happened. For routing surprises, the decision JSON (the
app's inspector → "Raw decision JSON", or `oneroute route --json "..."`) is the most useful thing to include. Remove
anything private from it first.

By contributing you agree that your contributions are licensed under the Apache License 2.0.
