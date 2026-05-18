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
index.html               entry — markup, Tailwind CDN, table skeleton
style.css                dark theme, APR colour scale, badges, calc panel
app.js                   fetchers, state, render, filters, calculator, watchlist
manifest.webmanifest     PWA manifest — enables Add-to-Home-Screen on iOS/Android
service-worker.js        minimal SW (cache shell, never cache APIs)
icons/                   192/512/180 px app icons (purple S on dark bg)
scripts/check-yields.mjs Alerts + daily digest (--digest flag picks mode)
.github/workflows/
  deploy.yml             GitHub Pages deploy on push to main / claude/* branches
  alerts.yml             5-min cron that runs check-yields.mjs (alert mode)
  digest.yml             daily cron (08:00 UTC) for category top-5 snapshot
.nojekyll                tells GitHub Pages this is plain static HTML
```

## Calculator

Clicking a row in the table expands a panel underneath with an auto-horizon
calculator. The user enters ONLY the amount; the calculator projects the
position across 5 category-appropriate horizons (1 cycle → 1 year for
funding; 1 day → 1 year for DeFi), computes break-even (when entry/exit
fees pay off), stars the horizon with the best net APY, and shows a
baseline comparison vs the safest liquid alternative (top stable lending
or fixed yield). Fees per category live in `feesForCategory()`. State
persists across re-renders via `calcStates` Map keyed on `source|market|category`.

## State and UX features

- **Watchlist** — star icon on every row toggles a row in/out of a localStorage
  set. The "★ избранные" filter shows only watched rows.
- **APR change arrows** — `state.previousApr` snapshots APRs at each refresh.
  The renderer diffs them and renders ▲/▼ next to changed values.
- **Filter persistence** — `state.filters` is saved to `localStorage` under
  `soomqa.filters.v1` and rehydrated on load.

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
