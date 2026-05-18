# Soomqa

Personal crypto yield monitor. Reads funding rates from Binance / Bybit / Hyperliquid and DeFi yields from Aave / Morpho / Pendle / Ethena / Sky in parallel, then prints a single sorted comparison table.

Built for one user (the operator). No SaaS layer, no auth, no clients. Phase 1.

## What you see when you run it

```
Soomqa — yield monitor

Fetching from 4 sources in parallel…
Got 17 yield rows.

┌────────────────────┬──────────────────────┬────────────┬──────────┬──────────┬────────────┐
│ Source             │ Market               │ Category   │ APR      │ Type     │ Note       │
├────────────────────┼──────────────────────┼────────────┼──────────┼──────────┼────────────┤
│ Hyperliquid fund.. │ HYPE-PERP            │ Funding    │  35.41%  │ variable │ hourly...  │
│ Pendle PT          │ PT-sUSDe (Ethereum)  │ Fixed      │  12.80%  │ fixed    │ yield...   │
│ Ethena sUSDe       │ sUSDe (Ethereum)     │ Δ-neutral  │  11.20%  │ variable │ packaged.. │
│ Morpho Blue        │ USDC (Base)          │ Lending    │   7.40%  │ variable │ isolated.. │
│ ...                │                      │            │          │          │            │
└────────────────────┴──────────────────────┴────────────┴──────────┴──────────┴────────────┘

Best APR overall: 35.41% (Hyperliquid funding — HYPE-PERP)
Best fixed yield: 12.80% (Pendle PT — PT-sUSDe)
```

## Setup (on a Mac)

```bash
git clone https://github.com/issasplash/soomqa.git
cd soomqa
npm install
npm start
```

That's it. No API keys needed for Phase 1 — every endpoint we hit is public.

Re-run `npm start` whenever you want a fresh snapshot. Funding rates refresh every 8 hours on Binance/Bybit and every hour on Hyperliquid; DeFi APYs move on every block.

For continuous monitoring later, run `npm run watch` (re-fetches on file change — useful while we add fetchers).

## Why this exists

Funding rates and DeFi yields move in opposite directions. When perps are skewed long, Binance pays you 30% APR to short — but Aave is paying 4%. When the market goes sideways, perps pay nothing but Morpho stables go to 12%. Knowing which layer to be in *right now* requires watching ~7 dashboards at once. This collapses them into one.

Phase 1 is read-only — it shows you the table. Execution (auto-rebalance, Telegram alerts, position tracking) comes in Phase 2.

## Architecture

```
src/
  index.ts             entry point — runs all fetchers in parallel, renders the table
  types.ts             shared YieldRow shape every fetcher returns
  http.ts              fetch wrapper with timeout
  fetchers/
    binance.ts         Binance USD-M futures funding (8h period → APR)
    bybit.ts           Bybit V5 linear funding (8h period → APR)
    hyperliquid.ts     Hyperliquid funding (1h period → APR)
    defillama.ts       Aggregated DeFi yields via DefiLlama /pools API
  render.ts            CLI table + summary
```

Adding a new fetcher: drop a file in `src/fetchers/`, implement `() => Promise<FetchResult<YieldRow[]>>`, register it in the `Promise.all` in `src/index.ts`. The table picks it up automatically.

## Roadmap

- **Phase 1 (this)** — read-only comparison across CEX funding + DeFi yields
- **Phase 2** — Pendle Boros (tokenised funding rates as fixed yield), Sky savings rate, restaking points
- **Phase 3** — Telegram alerts when an APR delta crosses a threshold (e.g. funding > stable yield by >15%)
- **Phase 4** — wallet/position tracker: input your actual deposits, see realised yield vs theoretical, drift alerts
- **Phase 5** — sybil-resistant airdrop wallet scheduler (the airdrop layer of the portfolio)
