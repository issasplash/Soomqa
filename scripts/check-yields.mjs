#!/usr/bin/env node
//
// Yield monitor — alert side.
//
// Runs from GitHub Actions on a 15-minute cron. Fetches the same four data
// sources the browser does (Binance funding + tickers + exchangeInfo, Bybit
// tickers, Hyperliquid metaAndAssetCtxs, DefiLlama pools), applies the same
// liquidity logic, picks out actionable signals, and posts them to Telegram.
//
// State lives in scripts/.cache/sent.json so the same opportunity doesn't
// spam the chat every 15 minutes. The GitHub Actions cache action persists
// this directory between runs.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const CACHE_DIR = "scripts/.cache";
const SENT_PATH = `${CACHE_DIR}/sent.json`;

// ─── Alert thresholds (intentionally NOT user-tunable here — these define
// what "interesting" means and need calibration over time, not casual edits). ─

const ALERT_RULES = [
  {
    id: "funding-spike",
    label: "Funding-спайк",
    match: r => r.category === "funding-rate" && r.liquid && r.apr >= 50,
    cooldownHours: 4,
  },
  {
    id: "fixed-yield-high",
    label: "Фикс. доходность",
    match: r => r.category === "fixed-yield" && r.liquid && r.apr >= 15,
    cooldownHours: 12,
  },
  {
    id: "stable-lending-high",
    label: "Лендинг стейблов",
    match: r => r.category === "stable-lending" && r.liquid && r.apr >= 8,
    cooldownHours: 12,
  },
  {
    id: "delta-neutral-high",
    label: "Δ-нейтрал (Ethena)",
    match: r => r.category === "delta-neutral" && r.liquid && r.apr >= 15,
    cooldownHours: 6,
  },
];

// ─── Shared constants (mirrors app.js — keep in sync) ─────────────────────────

const APR_8H = 3 * 365;
const APR_1H = 24 * 365;
const PERP_LIQUID_VOLUME_USD = 10_000_000;
const PERP_LIQUID_OI_USD = 5_000_000;
const PERP_SPIKE_BASIS_THRESHOLD = 0.003;

const CANONICAL_STABLES = ["USDC", "USDT", "DAI", "USDS", "USDE", "SUSDE", "SUSDS", "GHO", "PYUSD", "USR", "USDX"];
const CANONICAL_ETH_DERIVS = ["WSTETH", "STETH", "EETH", "EZETH", "RSETH", "PUFETH", "WBETH", "RETH"];

function symbolMatchesAny(symbol, needles) {
  const s = String(symbol ?? "").toUpperCase();
  return needles.some(n => s.includes(n.toUpperCase()));
}

function formatUsdShort(v) {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

async function getJson(url, init = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
const postJson = (url, body) => getJson(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function makePerpRow({ source, market, quote, apr, period, volumeUsd, openInterestUsd, basis, nonCrypto }) {
  const hasDepth = (volumeUsd >= PERP_LIQUID_VOLUME_USD) ||
                   (openInterestUsd >= PERP_LIQUID_OI_USD);
  const inActiveSpike = basis != null && Math.abs(basis) > PERP_SPIKE_BASIS_THRESHOLD;
  const liquid = hasDepth && !inActiveSpike && !nonCrypto;
  return {
    source, market, quote, apr, basis, volumeUsd, openInterestUsd, nonCrypto,
    category: "funding-rate", fixed: false, liquid,
  };
}

// ─── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchBinance() {
  try {
    const [funding, tickers, info] = await Promise.all([
      getJson("https://fapi.binance.com/fapi/v1/premiumIndex"),
      getJson("https://fapi.binance.com/fapi/v1/ticker/24hr"),
      getJson("https://fapi.binance.com/fapi/v1/exchangeInfo"),
    ]);
    const volumeBy = new Map();
    for (const t of tickers) volumeBy.set(t.symbol, Number(t.quoteVolume) || 0);
    const metaBy = new Map();
    for (const s of (info?.symbols ?? [])) {
      metaBy.set(s.symbol, { contractType: s.contractType, underlyingType: s.underlyingType });
    }
    return {
      ok: true,
      data: funding.filter(r => !r.symbol.includes("_")).map(r => {
        const quote = r.symbol.endsWith("USDC") ? "USDC" : "USDT";
        const market = r.symbol.replace(new RegExp(`${quote}$`), "");
        const apr = Number(r.lastFundingRate) * APR_8H * 100;
        const markPrice = Number(r.markPrice) || 0;
        const indexPrice = Number(r.indexPrice) || 0;
        const basis = indexPrice > 0 ? (markPrice - indexPrice) / indexPrice : null;
        const meta = metaBy.get(r.symbol) ?? {};
        const nonCrypto = meta.underlyingType != null && meta.underlyingType !== "COIN";
        return makePerpRow({
          source: "Binance", market, quote, apr, period: "8h",
          volumeUsd: volumeBy.get(r.symbol) ?? 0, openInterestUsd: 0,
          basis, nonCrypto,
        });
      }),
    };
  } catch (err) { return { ok: false, source: "Binance", error: err.message }; }
}

async function fetchBybit() {
  try {
    const data = await getJson("https://api.bybit.com/v5/market/tickers?category=linear");
    return {
      ok: true,
      data: (data?.result?.list ?? [])
        .filter(r => r.fundingRate != null && r.fundingRate !== "")
        .map(r => {
          let market = r.symbol, quote = "USDT";
          if (market.endsWith("PERP")) { market = market.replace(/PERP$/, ""); quote = "USDC"; }
          else if (market.endsWith("USDT")) market = market.replace(/USDT$/, "");
          const apr = Number(r.fundingRate) * APR_8H * 100;
          const lastPrice = Number(r.lastPrice) || 0;
          const indexPrice = Number(r.indexPrice) || 0;
          const basis = indexPrice > 0 ? (lastPrice - indexPrice) / indexPrice : null;
          return makePerpRow({
            source: "Bybit", market, quote, apr, period: "8h",
            volumeUsd: Number(r.turnover24h) || 0,
            openInterestUsd: Number(r.openInterestValue) || 0,
            basis,
          });
        }),
    };
  } catch (err) { return { ok: false, source: "Bybit", error: err.message }; }
}

async function fetchHyperliquid() {
  try {
    const [meta, ctxs] = await postJson("https://api.hyperliquid.xyz/info", { type: "metaAndAssetCtxs" });
    const rows = [];
    for (let i = 0; i < meta.universe.length; i++) {
      const asset = meta.universe[i], ctx = ctxs[i];
      if (!asset || !ctx) continue;
      const apr = Number(ctx.funding) * APR_1H * 100;
      const markPx = Number(ctx.markPx) || 0;
      const oraclePx = Number(ctx.oraclePx) || 0;
      const basis = oraclePx > 0 ? (markPx - oraclePx) / oraclePx : null;
      const oiUsd = (Number(ctx.openInterest) || 0) * markPx;
      rows.push(makePerpRow({
        source: "Hyperliquid", market: asset.name, quote: "USDC", apr, period: "1h",
        volumeUsd: Number(ctx.dayNtlVlm) || 0, openInterestUsd: oiUsd, basis,
      }));
    }
    return { ok: true, data: rows };
  } catch (err) { return { ok: false, source: "Hyperliquid", error: err.message }; }
}

async function fetchDefiLlama() {
  try {
    const resp = await getJson("https://yields.llama.fi/pools");
    if (resp.status !== "success") throw new Error(`bad status: ${resp.status}`);
    const PROJECT_RULES = [
      { project: "aave-v3",       minTvl: 50_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Aave v3" },
      { project: "morpho-blue",   minTvl: 50_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Morpho Blue" },
      { project: "spark",         minTvl: 50_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Spark" },
      { project: "sky-lending",   minTvl: 50_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Sky sUSDS" },
      { project: "pendle",        minTvl: 5_000_000,   symbols: null,               category: "fixed-yield",    source: "Pendle" },
      { project: "ethena-usde",   minTvl: 100_000_000, symbols: ["USDE", "SUSDE"],  category: "delta-neutral",  source: "Ethena" },
    ];
    const rows = [];
    for (const rule of PROJECT_RULES) {
      const pools = resp.data
        .filter(p => p.project === rule.project)
        .filter(p => (p.tvlUsd ?? 0) >= rule.minTvl)
        .filter(p => p.apy != null && p.apy > 0)
        .filter(p => rule.symbols === null || symbolMatchesAny(p.symbol, rule.symbols));
      for (const p of pools) {
        const apr = Number(p.apy) || 0;
        const apyBase = p.apyBase == null ? null : Number(p.apyBase);
        const apyReward = p.apyReward == null ? null : Number(p.apyReward);
        const apyMean30d = p.apyMean30d == null ? null : Number(p.apyMean30d);
        const tvl = Number(p.tvlUsd) || 0;
        const baseDominates = apyBase != null && apyBase >= apr * 0.5;
        const smoothedAgrees = apyMean30d != null && apyMean30d >= apr * 0.6;
        const tvlSubstantial = tvl >= rule.minTvl * 2;
        const liquid = !p.outlier && (baseDominates || smoothedAgrees) && tvlSubstantial;
        rows.push({
          source: rule.source,
          market: `${p.symbol}`,
          chain: p.chain,
          category: rule.category,
          apr,
          fixed: rule.category === "fixed-yield",
          liquid,
          apyBase, apyReward, apyMean30d,
          tvl,
        });
      }
    }
    return { ok: true, data: rows };
  } catch (err) { return { ok: false, source: "DefiLlama", error: err.message }; }
}

// ─── Cache (dedup) ────────────────────────────────────────────────────────────

async function loadSentCache() {
  if (!existsSync(SENT_PATH)) return {};
  try { return JSON.parse(await readFile(SENT_PATH, "utf8")); } catch { return {}; }
}

async function saveSentCache(cache) {
  if (!existsSync(CACHE_DIR)) await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(SENT_PATH, JSON.stringify(cache, null, 2));
}

function alertKey(row, rule) {
  return `${rule.id}:${row.source}:${row.market}${row.chain ? ":" + row.chain : ""}`;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping send.");
    console.log("[telegram] Would have sent:\n" + text);
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram error ${res.status}: ${body}`);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

function formatAlertBlock(rule, rows) {
  const head = `<b>${escapeHtml(rule.label)}</b>`;
  const lines = rows.slice(0, 8).map(r => {
    const apr = r.apr.toFixed(2);
    const where = r.chain ? `${r.source} · ${r.market} (${r.chain})` : `${r.source} · ${r.market}${r.quote ? "/" + r.quote : ""}`;
    let extra = "";
    if (r.category === "funding-rate" && r.volumeUsd) extra = ` · об. ${formatUsdShort(r.volumeUsd)}`;
    if (r.tvl) extra = ` · TVL ${formatUsdShort(r.tvl)}`;
    return `  • <code>${escapeHtml(where)}</code> — <b>${apr}%</b>${extra}`;
  });
  return [head, ...lines].join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function fetchAll() {
  const results = await Promise.all([
    fetchBinance(), fetchBybit(), fetchHyperliquid(), fetchDefiLlama(),
  ]);
  const rows = [];
  const failures = [];
  for (const r of results) {
    if (r.ok) rows.push(...r.data);
    else failures.push(r);
  }
  return { rows, failures };
}

async function runAlerts() {
  console.log("Fetching for alerts…");
  const { rows, failures } = await fetchAll();
  console.log(`Got ${rows.length} rows; failures: ${failures.length}`);
  for (const f of failures) console.warn(`  ${f.source}: ${f.error}`);

  const sent = await loadSentCache();
  const now = Date.now();

  const blocks = [];
  const newlySent = { ...sent };

  for (const rule of ALERT_RULES) {
    const matches = rows.filter(rule.match);
    if (matches.length === 0) continue;

    const cooldownMs = rule.cooldownHours * 60 * 60 * 1000;
    const fresh = matches.filter(r => {
      const key = alertKey(r, rule);
      const lastSent = sent[key];
      return !lastSent || (now - lastSent) >= cooldownMs;
    });
    if (fresh.length === 0) continue;

    fresh.sort((a, b) => b.apr - a.apr);
    blocks.push(formatAlertBlock(rule, fresh));

    for (const r of fresh) newlySent[alertKey(r, rule)] = now;
  }

  if (blocks.length === 0) {
    console.log("No new alerts.");
    return;
  }

  const header = `📡 <b>Soomqa — алерты</b>\n<i>${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</i>`;
  const message = [header, ...blocks].join("\n\n");

  console.log("Sending alert message:\n" + message);
  await sendTelegram(message);
  await saveSentCache(newlySent);
  console.log("Done.");
}

// Daily digest mode — runs on a separate cron, ignores the dedup cache, and
// sends a "what's worth looking at right now" snapshot. Always sends so the
// user has a daily anchor even when there are no fresh spikes.
async function runDigest() {
  console.log("Fetching for daily digest…");
  const { rows, failures } = await fetchAll();
  console.log(`Got ${rows.length} rows; failures: ${failures.length}`);

  // Pick top 5 by APR per category, but only from liquid rows — the digest
  // should be actionable, not noise. Filter empty categories afterwards.
  const CATEGORIES = [
    { key: "stable-lending", label: "Лендинг стейблов", emoji: "🏦" },
    { key: "fixed-yield",    label: "Фикс. доходность", emoji: "📜" },
    { key: "delta-neutral",  label: "Δ-нейтрал",        emoji: "⚖️" },
    { key: "funding-rate",   label: "Funding (ликвидные)", emoji: "🔄" },
    { key: "restaking",      label: "Рестейкинг",       emoji: "🧱" },
  ];

  const blocks = [];
  for (const cat of CATEGORIES) {
    const inCat = rows.filter(r => r.category === cat.key && r.liquid && r.apr > 0);
    if (inCat.length === 0) continue;
    inCat.sort((a, b) => b.apr - a.apr);
    const top = inCat.slice(0, 5);
    const lines = top.map(r => {
      const where = r.chain
        ? `${r.source} · ${r.market} (${r.chain})`
        : `${r.source} · ${r.market}${r.quote ? "/" + r.quote : ""}`;
      const tvlOrVol = r.tvl
        ? ` · TVL ${formatUsdShort(r.tvl)}`
        : r.volumeUsd
          ? ` · об. ${formatUsdShort(r.volumeUsd)}`
          : "";
      return `  • <code>${escapeHtml(where)}</code> — <b>${r.apr.toFixed(2)}%</b>${tvlOrVol}`;
    });
    blocks.push(`${cat.emoji} <b>${cat.label}</b>\n${lines.join("\n")}`);
  }

  if (blocks.length === 0) {
    console.log("Nothing to digest (probably all sources failed). Skipping.");
    return;
  }

  const totalLiquid = rows.filter(r => r.liquid).length;
  const totalRows = rows.length;
  const header = `📊 <b>Soomqa — ежедневный обзор</b>
<i>${new Date().toISOString().slice(0, 10)}</i>
Всего рынков: ${totalRows} · ликвидных: ${totalLiquid}`;

  const footer = failures.length > 0
    ? `\n\n<i>⚠ Источники с ошибками: ${failures.map(f => f.source).join(", ")}</i>`
    : "";

  const message = [header, ...blocks].join("\n\n") + footer;

  console.log("Sending digest:\n" + message);
  await sendTelegram(message);
  console.log("Done.");
}

async function main() {
  // Dispatch on a CLI flag — keeps everything in one file so the fetcher
  // logic doesn't drift between alert and digest modes.
  const mode = process.argv.includes("--digest") ? "digest" : "alerts";
  if (mode === "digest") await runDigest();
  else await runAlerts();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
