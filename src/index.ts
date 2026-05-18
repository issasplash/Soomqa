import "dotenv/config";
import chalk from "chalk";

import { fetchBinanceFunding } from "./fetchers/binance.js";
import { fetchBybitFunding } from "./fetchers/bybit.js";
import { fetchHyperliquidFunding } from "./fetchers/hyperliquid.js";
import { fetchDefiLlama } from "./fetchers/defillama.js";
import { renderYields, renderFailures, renderSummary } from "./render.js";
import type { FetchResult, YieldRow } from "./types.js";

async function main() {
  console.log(chalk.bold.cyan("\nSoomqa — yield monitor\n"));
  console.log(chalk.dim("Fetching from 4 sources in parallel…"));

  const results = await Promise.all([
    fetchBinanceFunding(),
    fetchBybitFunding(),
    fetchHyperliquidFunding(),
    fetchDefiLlama(),
  ]);

  const rows: YieldRow[] = [];
  const failures: Array<{ source: string; error: string }> = [];

  for (const result of results as FetchResult<YieldRow[]>[]) {
    if (result.ok) {
      rows.push(...result.data);
    } else {
      failures.push({ source: result.source, error: result.error });
    }
  }

  console.log(chalk.dim(`Got ${rows.length} yield rows.\n`));

  if (rows.length > 0) {
    console.log(renderYields(rows));
    console.log();
    console.log(renderSummary(rows));
  }

  if (failures.length > 0) {
    console.log(renderFailures(failures));
  }

  console.log();
}

main().catch((err) => {
  console.error(chalk.red("\nFatal error:"), err);
  process.exit(1);
});
