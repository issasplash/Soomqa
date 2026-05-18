# CLAUDE.md

Guidance for Claude when working in this repository.

## Project

**Soomqa** — personal crypto yield monitor. CLI written in Node.js + TypeScript that pulls funding rates from CEXes and yield APYs from DeFi protocols, normalises them into a single comparable `YieldRow` shape, and prints a sorted table.

Used by **one operator** (the repo owner). Not a SaaS, no auth, no users.

## Stack

- Node.js ≥ 20, ESM modules
- TypeScript (no build step in dev — `tsx` runs `.ts` directly)
- No frameworks. `chalk` for colour, `cli-table3` for the table, `dotenv` for env vars.

## Repository layout

```
src/
  index.ts             entry point
  types.ts             shared shapes (YieldRow, FetchResult, YieldCategory)
  http.ts              fetch wrapper with timeout
  fetchers/            one file per data source; each exports an async function
                       returning FetchResult<YieldRow[]>
  render.ts            CLI table renderer + summary
```

Run with `npm start`. Typecheck with `npm run typecheck`.

## Conventions

- **Every fetcher is independent.** They never share state. They return `FetchResult<YieldRow[]>` so failures don't crash the whole run — `index.ts` collects partial results and shows what failed.
- **Annualisation:** Binance/Bybit funding = rate × 3 × 365 (8h periods). Hyperliquid = rate × 24 × 365 (hourly). DefiLlama already returns APY.
- **Adding a fetcher:** drop a file in `src/fetchers/`, register in `Promise.all` in `index.ts`. No other wiring needed — the renderer iterates over `YieldRow[]` generically.
- **No secrets in code.** `.env` is gitignored; `.env.example` documents shape only. Phase 1 needs no keys (all endpoints public).
- **Sandboxed dev environments may block outbound HTTP.** If `npm start` returns 403s for every source, that's the environment, not the code. Run locally.

## Non-goals (deliberate)

- No web UI. CLI only. Adds value, not surface area.
- No bundler / no transpile step. `tsx` is enough.
- No tests yet. Will add when behaviour stabilises past Phase 2.
- No persistence yet. Each run is stateless; positions/history land in Phase 4.
