// Common shape every fetcher returns. The renderer iterates over these
// without caring which protocol they came from.
export interface YieldRow {
  /** Where the yield comes from — "Binance funding", "Ethena sUSDe", etc. */
  source: string;
  /** Asset / market identifier shown to the user — e.g. "BTC-PERP", "USDC", "PT-sUSDe Dec2026". */
  market: string;
  /** Risk-adjusted bucket — used for sorting and colouring. */
  category: YieldCategory;
  /** Annualised yield, expressed as a percent (e.g. 12.5 means 12.5% APR). */
  apr: number;
  /**
   * Whether the APR is contractually locked until maturity (true) or floats
   * with market conditions (false). Fixed yields are sorted ahead of variable
   * ones at equal APR.
   */
  fixed: boolean;
  /** Free-text note: liquidation risk, depeg risk, lockup, etc. */
  note?: string;
  /** Capital required to make the strategy economic, in USD. */
  minCapitalUsd?: number;
}

export type YieldCategory =
  | "funding-rate"       // perpetual futures funding (CEX)
  | "fixed-yield"        // Pendle PT, Boros YU, Treasury bills
  | "stable-lending"     // Aave / Compound / Morpho stablecoin deposits
  | "delta-neutral"      // Ethena, packaged funding arb
  | "restaking"          // EigenLayer / Symbiotic / Karak base yield
  | "leveraged-stable";  // recursive stablecoin loops

/** Wraps the result of a fetch so failures don't crash the whole comparison. */
export type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; source: string; error: string };
