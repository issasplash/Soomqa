import { getJson } from "../http.js";
import type { FetchResult, YieldCategory, YieldRow } from "../types.js";

// DefiLlama's /pools endpoint aggregates yields across hundreds of protocols.
// Filtering here keeps us focused on the layers we actually want to compare:
// stable lending, fixed yields (Pendle), delta-neutral (Ethena), restaking.
//
// API: https://yields.llama.fi/pools

interface LlamaPool {
  pool: string;
  project: string;
  chain: string;
  symbol: string;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  stablecoin: boolean;
  tvlUsd: number;
}

interface LlamaResponse {
  status: string;
  data: LlamaPool[];
}

interface PickRule {
  project: string;
  symbolIncludes?: string[];
  category: YieldCategory;
  source: string;
  fixed: boolean;
  note: string;
  minCapitalUsd: number;
  minTvlUsd: number;
}

// The shape we care about per layer. Each rule pulls the highest-APR matching
// pool from DefiLlama. Symbol filter is case-insensitive substring match.
const RULES: PickRule[] = [
  {
    project: "aave-v3",
    symbolIncludes: ["USDC", "USDT"],
    category: "stable-lending",
    source: "Aave v3",
    fixed: false,
    note: "instant withdrawal, lowest risk in layer",
    minCapitalUsd: 100,
    minTvlUsd: 50_000_000,
  },
  {
    project: "morpho-blue",
    symbolIncludes: ["USDC", "USDT"],
    category: "stable-lending",
    source: "Morpho Blue",
    fixed: false,
    note: "isolated markets; check curator before depositing",
    minCapitalUsd: 100,
    minTvlUsd: 10_000_000,
  },
  {
    project: "ethena-usde",
    symbolIncludes: ["SUSDE", "USDE"],
    category: "delta-neutral",
    source: "Ethena sUSDe",
    fixed: false,
    note: "packaged funding arb — yield drops in bear markets",
    minCapitalUsd: 100,
    minTvlUsd: 500_000_000,
  },
  {
    project: "pendle",
    symbolIncludes: ["PT-"],
    category: "fixed-yield",
    source: "Pendle PT",
    fixed: true,
    note: "yield locked until maturity; principal exposure to underlying",
    minCapitalUsd: 500,
    minTvlUsd: 5_000_000,
  },
  {
    project: "sky-lending",
    symbolIncludes: ["SUSDS", "DAI"],
    category: "stable-lending",
    source: "Sky sUSDS",
    fixed: false,
    note: "governance-managed savings rate, lowest-risk RWA-backed yield",
    minCapitalUsd: 100,
    minTvlUsd: 100_000_000,
  },
];

export async function fetchDefiLlama(): Promise<FetchResult<YieldRow[]>> {
  try {
    const data = await getJson<LlamaResponse>("https://yields.llama.fi/pools");
    if (data.status !== "success") {
      throw new Error(`unexpected status: ${data.status}`);
    }

    const rows: YieldRow[] = [];

    for (const rule of RULES) {
      const matches = data.data
        .filter((p) => p.project === rule.project)
        .filter((p) => p.tvlUsd >= rule.minTvlUsd)
        .filter((p) => p.apy !== null && p.apy > 0)
        .filter((p) => {
          if (!rule.symbolIncludes) return true;
          const sym = p.symbol.toUpperCase();
          return rule.symbolIncludes.some((needle) =>
            sym.includes(needle.toUpperCase()),
          );
        });

      if (matches.length === 0) continue;

      // Sort descending by APR, take the top pool for this rule.
      matches.sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0));
      const best = matches[0]!;

      rows.push({
        source: rule.source,
        market: `${best.symbol} (${best.chain})`,
        category: rule.category,
        apr: best.apy ?? 0,
        fixed: rule.fixed,
        note: rule.note,
        minCapitalUsd: rule.minCapitalUsd,
      });
    }

    return { ok: true, data: rows };
  } catch (err) {
    return {
      ok: false,
      source: "DefiLlama",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
