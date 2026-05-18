import chalk, { type ChalkInstance } from "chalk";
import Table from "cli-table3";
import type { YieldRow } from "./types.js";

const HEADERS = [
  "Source",
  "Market",
  "Category",
  "APR",
  "Type",
  "Min capital",
  "Note",
];

const CATEGORY_LABEL: Record<string, string> = {
  "funding-rate": "Funding",
  "fixed-yield": "Fixed",
  "stable-lending": "Lending",
  "delta-neutral": "Δ-neutral",
  "restaking": "Restake",
  "leveraged-stable": "Lev. stable",
};

function colourForApr(apr: number): ChalkInstance {
  if (apr >= 15) return chalk.green;
  if (apr >= 8) return chalk.cyan;
  if (apr >= 3) return chalk.white;
  if (apr >= 0) return chalk.gray;
  return chalk.red; // negative funding — short leg gets paid
}

function formatCapital(usd: number | undefined): string {
  if (usd === undefined) return "—";
  if (usd >= 1000) return `$${(usd / 1000).toFixed(0)}k+`;
  return `$${usd}+`;
}

export function renderYields(rows: YieldRow[]): string {
  // Sort by APR descending — most attractive options at top.
  const sorted = [...rows].sort((a, b) => b.apr - a.apr);

  const table = new Table({
    head: HEADERS.map((h) => chalk.bold(h)),
    style: { head: [], border: ["gray"] },
    wordWrap: true,
    colWidths: [20, 22, 12, 10, 8, 12, 40],
  });

  for (const row of sorted) {
    const aprFmt = colourForApr(row.apr)(`${row.apr.toFixed(2)}%`);
    table.push([
      row.source,
      row.market,
      CATEGORY_LABEL[row.category] ?? row.category,
      aprFmt,
      row.fixed ? chalk.magenta("fixed") : chalk.dim("variable"),
      formatCapital(row.minCapitalUsd),
      chalk.dim(row.note ?? ""),
    ]);
  }

  return table.toString();
}

export function renderFailures(
  failures: Array<{ source: string; error: string }>,
): string {
  if (failures.length === 0) return "";
  const lines = failures.map(
    (f) => `  ${chalk.yellow("•")} ${chalk.bold(f.source)}: ${chalk.dim(f.error)}`,
  );
  return `\n${chalk.yellow("Some sources failed:")}\n${lines.join("\n")}\n`;
}

export function renderSummary(rows: YieldRow[]): string {
  if (rows.length === 0) return chalk.red("No yields fetched.");

  const best = rows.reduce((a, b) => (b.apr > a.apr ? b : a));
  const bestFixed = rows
    .filter((r) => r.fixed)
    .reduce<YieldRow | null>((a, b) => (a && a.apr > b.apr ? a : b), null);

  const lines: string[] = [];
  lines.push(
    chalk.bold("Best APR overall: ") +
      chalk.green(`${best.apr.toFixed(2)}%`) +
      chalk.dim(` (${best.source} — ${best.market})`),
  );
  if (bestFixed) {
    lines.push(
      chalk.bold("Best fixed yield: ") +
        chalk.magenta(`${bestFixed.apr.toFixed(2)}%`) +
        chalk.dim(` (${bestFixed.source} — ${bestFixed.market})`),
    );
  }
  lines.push(
    chalk.dim(
      "Variable APRs (funding rates, Ethena, Aave) move daily — re-run to refresh.",
    ),
  );
  return lines.join("\n");
}
