import { getJson } from "../http.js";
import type { FetchResult, YieldRow } from "../types.js";

// Binance pays funding every 8 hours, so the annualised rate is the per-period
// rate * 3 funding events/day * 365 days. Same convention as their UI shows.
const PERIODS_PER_YEAR = 3 * 365;

interface PremiumIndex {
  symbol: string;
  lastFundingRate: string;
  markPrice: string;
}

const MARKETS_OF_INTEREST = new Set([
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "HYPEUSDT",
]);

export async function fetchBinanceFunding(): Promise<FetchResult<YieldRow[]>> {
  try {
    const data = await getJson<PremiumIndex[]>(
      "https://fapi.binance.com/fapi/v1/premiumIndex",
    );

    const rows: YieldRow[] = data
      .filter((row) => MARKETS_OF_INTEREST.has(row.symbol))
      .map((row) => {
        const ratePerPeriod = Number(row.lastFundingRate);
        const apr = ratePerPeriod * PERIODS_PER_YEAR * 100;
        return {
          source: "Binance funding",
          market: row.symbol.replace("USDT", "-PERP"),
          category: "funding-rate",
          apr,
          fixed: false,
          note: "variable — flips negative in bear/sideways markets",
          minCapitalUsd: 2000,
        };
      });

    return { ok: true, data: rows };
  } catch (err) {
    return {
      ok: false,
      source: "Binance funding",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
