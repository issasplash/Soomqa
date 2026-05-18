import { postJson } from "../http.js";
import type { FetchResult, YieldRow } from "../types.js";

// Hyperliquid funding accrues every hour, so APR = hourly_rate * 24 * 365.
const PERIODS_PER_YEAR = 24 * 365;

interface AssetMeta {
  name: string;
}

interface AssetCtx {
  funding: string;
  markPx: string;
}

// `metaAndAssetCtxs` returns [meta, ctxs[]] in a tuple-style array.
type MetaAndCtxs = [{ universe: AssetMeta[] }, AssetCtx[]];

const MARKETS_OF_INTEREST = new Set(["BTC", "ETH", "SOL", "HYPE"]);

export async function fetchHyperliquidFunding(): Promise<FetchResult<YieldRow[]>> {
  try {
    const data = await postJson<MetaAndCtxs>(
      "https://api.hyperliquid.xyz/info",
      { type: "metaAndAssetCtxs" },
    );

    const [meta, ctxs] = data;
    const rows: YieldRow[] = [];

    for (let i = 0; i < meta.universe.length; i++) {
      const asset = meta.universe[i];
      const ctx = ctxs[i];
      if (!asset || !ctx) continue;
      if (!MARKETS_OF_INTEREST.has(asset.name)) continue;

      const apr = Number(ctx.funding) * PERIODS_PER_YEAR * 100;
      rows.push({
        source: "Hyperliquid funding",
        market: `${asset.name}-PERP`,
        category: "funding-rate",
        apr,
        fixed: false,
        note: "hourly funding — short leg here for cross-exchange arb",
        minCapitalUsd: 2000,
      });
    }

    return { ok: true, data: rows };
  } catch (err) {
    return {
      ok: false,
      source: "Hyperliquid funding",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
