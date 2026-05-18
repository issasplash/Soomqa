# Soomqa

Personal crypto yield monitor. Single-page web app that compares funding rates from major exchanges with DeFi APYs in one view. Open in any browser — no terminal, no install, no API keys.

## Live URL

After the first push to `main`, GitHub Pages publishes to:

```
https://issasplash.github.io/Soomqa/
```

Open that URL on your phone or laptop. It auto-refreshes every 60 seconds.

## What it shows

- **All perpetual markets** on Binance, Bybit, and Hyperliquid (~500+ symbols total), with funding rates annualised to APR
- **DeFi yields** across Aave, Compound, Morpho, Spark, Sky, Pendle, Ethena, EigenLayer, Ether.fi, Renzo, Kelp, Puffer — pulled live from DefiLlama
- **Sorted by APR**, filterable by symbol, category, or minimum APR
- **Summary cards**: best overall, best fixed yield, best stable lending, total markets tracked

All read-only public data. No accounts, no wallet connection.

## Running locally

If you want to open the page directly without waiting for the GitHub Pages deploy:

1. Clone the repo on your Mac
2. Open `index.html` in any browser (just double-click it)

That's it — there's no build step. The page makes the API calls itself.

## Deploying via GitHub Pages

1. Push this repo to `main` on GitHub (or merge the working branch)
2. Go to **Settings → Pages → Source** and select **GitHub Actions**
3. The included workflow (`.github/workflows/deploy.yml`) handles the rest

After the first deploy completes (~1 minute), the URL above goes live.

## Architecture

Single-page app, vanilla JS. No framework, no bundler.

```
index.html          markup, Tailwind via CDN, semantic table layout
style.css           dark theme, APR colour scale, category badges
app.js              fetchers + state + render loop
.github/workflows/  GitHub Pages deploy on push to main
```

Adding a new data source: write another `fetchX()` function in `app.js` that returns `{ ok, data: rows[] } | { ok: false, source, error }` and add it to the `Promise.all` in `refreshData()`. The table picks it up automatically.

## Data sources

| Source | Endpoint | Covers |
|---|---|---|
| Binance | `fapi.binance.com/fapi/v1/premiumIndex` | All USDT/USDC perp funding rates |
| Bybit | `api.bybit.com/v5/market/tickers?category=linear` | All linear perp funding rates |
| Hyperliquid | `api.hyperliquid.xyz/info` | All HL perp funding rates (hourly) |
| DefiLlama | `yields.llama.fi/pools` | Aave, Morpho, Pendle, Ethena, restaking LRTs, etc. |

All endpoints are public and CORS-friendly. If one source fails, the others still render and the failure is surfaced in a banner.

## Roadmap

- **Phase 1** (this) — live read-only comparison across CEX funding + DeFi yields
- **Phase 2** — Pendle Boros (tokenised funding rates as fixed yield), funding-rate spread arbitrage view (long leg one exchange + short leg another, locked APR)
- **Phase 3** — Telegram alerts (separate Cloudflare Worker) when APR-delta crosses a threshold
- **Phase 4** — position tracker: paste your deposits, see realised vs theoretical yield, drift alerts
- **Phase 5** — airdrop-farming layer: wallet scheduler with sybil-resistant action hygiene
