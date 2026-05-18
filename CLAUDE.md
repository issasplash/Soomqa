# CLAUDE.md

Guidance for Claude when working in this repository.

## Project

**Soomqa** — personal crypto yield monitor. Single-page web app that pulls funding rates from Binance / Bybit / Hyperliquid and DeFi APYs (Aave, Morpho, Pendle, Ethena, Sky, restaking LRTs via DefiLlama) and renders one comparison table.

Used by **one operator** (the repo owner). Not a SaaS, no auth, no users. Mobile-friendly because the operator works from a phone.

## Stack

- Vanilla HTML / CSS / JavaScript — no build step, no bundler
- Tailwind via CDN for layout
- All API calls happen in the browser (every endpoint is CORS-friendly)
- Deployed via GitHub Pages with a workflow in `.github/workflows/deploy.yml`

## Repository layout

```
index.html            entry — markup, Tailwind CDN, table skeleton
style.css             dark theme, APR colour scale, category badges
app.js                everything else (fetchers, state, render, filters)
.github/workflows/    GitHub Pages deploy (triggers on push to main)
.nojekyll             tells GitHub Pages this is plain static HTML
```

## Conventions

- **Every fetcher is independent.** Each `fetchX()` returns `{ ok: true, data: rows[] } | { ok: false, source, error }`. The render loop pushes successful rows into a flat list and surfaces failures in a banner. One broken source never blocks the rest.
- **Annualisation:** Binance/Bybit funding = rate × 3 × 365 (8h periods). Hyperliquid = rate × 24 × 365 (hourly). DefiLlama already returns APY.
- **Adding a fetcher:** write the function in `app.js`, add it to `Promise.all` in `refreshData()`. No other wiring needed.
- **No build step.** If you find yourself reaching for a framework or bundler, stop — the constraint is deliberate. The user doesn't run terminals, and a static repo deploys to Pages in seconds.
- **Mobile first.** The user opens this on a phone. Test layouts under `sm:` breakpoint before adding columns.

## Non-goals (deliberate)

- No backend. No API keys. No accounts.
- No wallet connection (yet — comes in Phase 4 when we track positions).
- No frameworks. Plain DOM is enough at this scale.
- No tests yet. The user-facing signal of correctness is "the table shows numbers that match the exchange UIs"; we lean on that until behaviour stabilises.

## Common gotchas

- Tailwind CDN compiles classes at runtime. If a class doesn't take effect, check spelling — there's no error.
- DefiLlama returns ~13,000 pools. We filter aggressively in `fetchDefiLlama()`; expanding the project whitelist is the main way we surface more yields.
- A few exchanges expose delivery futures alongside perps (e.g. `BTCUSDT_240329`). Filter them out by looking for `_` in the symbol.
- The user is in Russia and uses a phone for most reading. Keep colour contrast high and font sizes legible at narrow widths.
