import { getJson } from "../http.js";
import type { FetchResult, YieldRow } from "../types.js";

const PERIODS_PER_YEAR = 3 * 365;

interface BybitTickersResponse {
  result: {
    list: Array<{
      symbol: string;
      fundingRate: string;
    }>;
  };
}

const MARKETS_OF_INTEREST = new Set([
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "HYPEUSDT",
]);

export async function fetchBybitFunding(): Promise<FetchResult<YieldRow[]>> {
  try {
    const data = await getJson<BybitTickersResponse>(
      "https://api.bybit.com/v5/market/tickers?category=linear",
    );

    const rows: YieldRow[] = data.result.list
      .filter((row) => MARKETS_OF_INTEREST.has(row.symbol))
      .map((row) => {
        const ratePerPeriod = Number(row.fundingRate);
        const apr = ratePerPeriod * PERIODS_PER_YEAR * 100;
        return {
          source: "Bybit funding",
          market: row.symbol.replace("USDT", "-PERP"),
          category: "funding-rate",
          apr,
          fixed: false,
          note: "variable — pair with opposite-leg exchange for delta-neutral",
          minCapitalUsd: 2000,
        };
      });

    return { ok: true, data: rows };
  } catch (err) {
    return {
      ok: false,
      source: "Bybit funding",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
