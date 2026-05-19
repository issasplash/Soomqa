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

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
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
  {
    id: "cross-exchange-spread",
    label: "Cross-exchange спред",
    match: r => r.category === "cross-exchange-spread" && r.liquid && r.apr >= 20,
    cooldownHours: 4,
  },
  // ── Composite rules — multiple conditions AND'd together ─────────────────
  // These exist to catch *sustainable* opportunities the simple thresholds
  // miss: high APR alone is noisy, but APR + volume + basis-converged is
  // a real arbitrage signal worth waking the user for.
  {
    id: "sustainable-funding-spike",
    label: "🔥 Устойчивый funding-спайк",
    match: r =>
      r.category === "funding-rate" &&
      r.liquid &&
      !r.nonCrypto &&
      r.apr >= 30 &&
      (r.volumeUsd ?? 0) >= 50_000_000 &&         // deep market
      (r.basis == null || Math.abs(r.basis) < 0.005),  // basis already converged → APR is real, not arb-in-progress
    cooldownHours: 6,
  },
  {
    id: "deep-stable-yield",
    label: "💎 Глубокий стейбл-yield",
    match: r =>
      r.category === "stable-lending" &&
      r.liquid &&
      r.apr >= 7 &&
      (r.tvl ?? 0) >= 200_000_000,
    cooldownHours: 24,
  },
  {
    id: "exceptional-spread",
    label: "⚡ Жирный cross-spread",
    match: r =>
      r.category === "cross-exchange-spread" &&
      r.liquid &&
      r.apr >= 40 &&
      r.longLeg && r.shortLeg &&
      r.longLeg.liquid && r.shortLeg.liquid,
    cooldownHours: 3,
  },
];

// ─── Historical snapshot writer ──────────────────────────────────────────────
//
// Append-only JSONL files at data/history/YYYY-MM-DD.jsonl. One line per
// (row × hour); we skip a write for any row we've already snapshotted within
// the current hour, so repeated 5-min runs don't bloat history.
//
// Foundation for the backtesting feature: after a month of data we can
// compute "what would $1000 in this pool have earned over the last 30 days".

const HISTORY_DIR = "data/history";

async function recordHistorySnapshot(rows) {
  const interesting = rows.filter(r =>
    r.liquid &&
    !r.nonCrypto &&
    ["funding-rate", "fixed-yield", "stable-lending", "delta-neutral",
     "restaking", "cross-exchange-spread"].includes(r.category),
  );
  if (interesting.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);
  const filepath = `${HISTORY_DIR}/${today}.jsonl`;
  await mkdir(HISTORY_DIR, { recursive: true });

  // Build a set of keys already written within the current hour — used to
  // dedupe within-the-hour writes. Cheap: just scan today's file.
  const seenThisHour = new Set();
  const oneHourAgoMs = Date.now() - 60 * 60 * 1000;
  if (existsSync(filepath)) {
    try {
      const existing = await readFile(filepath, "utf8");
      for (const line of existing.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.t >= oneHourAgoMs) seenThisHour.add(rec.k);
        } catch {}
      }
    } catch {}
  }

  const now = Date.now();
  const newLines = [];
  for (const r of interesting) {
    const key = `${r.source}|${r.market}|${r.category}`;
    if (seenThisHour.has(key)) continue;
    newLines.push(JSON.stringify({
      t: now,
      k: key,
      apr: Number(r.apr.toFixed(4)),
      liq: 1,
    }));
  }

  if (newLines.length === 0) {
    console.log(`[history] No new hourly entries for ${today} (${seenThisHour.size} already written).`);
    return;
  }

  await appendFile(filepath, newLines.join("\n") + "\n");
  console.log(`[history] Appended ${newLines.length} entries to ${filepath}`);
}

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

async function fetchMexcFunding() {
  try {
    const [fundings, tickers] = await Promise.all([
      getJson("https://contract.mexc.com/api/v1/contract/funding_rate/all"),
      getJson("https://contract.mexc.com/api/v1/contract/ticker"),
    ]);
    const volumeBy = new Map();
    for (const t of (tickers?.data ?? [])) volumeBy.set(t.symbol, Number(t.amount24) || 0);
    const rows = (fundings?.data ?? []).map(r => {
      const apr = Number(r.fundingRate ?? 0) * APR_8H * 100;
      const market = r.symbol.replace(/_USDT$/, "");
      return makePerpRow({
        source: "MEXC", market, quote: "USDT", apr, period: "8h",
        volumeUsd: volumeBy.get(r.symbol) ?? 0, openInterestUsd: 0, basis: null,
      });
    });
    return { ok: true, data: rows };
  } catch (err) { return { ok: false, source: "MEXC", error: err.message }; }
}

async function fetchGateFunding() {
  try {
    const data = await getJson("https://api.gateio.ws/api/v4/futures/usdt/contracts");
    const rows = (Array.isArray(data) ? data : []).map(r => {
      const intervalSec = Number(r.funding_interval) || 28800;
      const periodsPerYear = (365 * 24 * 3600) / intervalSec;
      const apr = Number(r.funding_rate ?? 0) * periodsPerYear * 100;
      const market = r.name.replace(/_USDT$/, "");
      const markPrice = Number(r.mark_price ?? 0);
      const indexPrice = Number(r.index_price ?? 0);
      const basis = indexPrice > 0 ? (markPrice - indexPrice) / indexPrice : null;
      return makePerpRow({
        source: "Gate.io", market, quote: "USDT", apr,
        period: intervalSec === 3600 ? "1h" : "8h",
        volumeUsd: Number(r.trade_size_24h_usd ?? 0), openInterestUsd: 0, basis,
      });
    });
    return { ok: true, data: rows };
  } catch (err) { return { ok: false, source: "Gate.io", error: err.message }; }
}

async function fetchHtxFunding() {
  try {
    const data = await getJson("https://api.hbdm.com/linear-swap-api/v1/swap_batch_funding_rate");
    const rows = (data?.data ?? []).map(r => {
      const apr = Number(r.funding_rate ?? 0) * APR_8H * 100;
      const market = r.contract_code.replace(/-USDT$/, "");
      return makePerpRow({
        source: "HTX", market, quote: "USDT", apr, period: "8h",
        volumeUsd: 0, openInterestUsd: 0, basis: null,
      });
    });
    return { ok: true, data: rows };
  } catch (err) { return { ok: false, source: "HTX", error: err.message }; }
}

// Synthesise cross-exchange spread rows from per-venue funding rates.
// Same logic as the browser's computeCrossExchangeSpreads — keep them in sync.
function computeCrossExchangeSpreads(rows) {
  const fundingRows = rows.filter(r =>
    r.category === "funding-rate" && !r.nonCrypto && r.market,
  );
  const bySymbol = new Map();
  for (const r of fundingRows) {
    if (!bySymbol.has(r.market)) bySymbol.set(r.market, []);
    bySymbol.get(r.market).push(r);
  }
  const SPREAD_MIN = 3;
  const out = [];
  for (const [market, group] of bySymbol) {
    if (group.length < 2) continue;
    const liquidGroup = group.filter(r => r.liquid);
    const candidates = liquidGroup.length >= 2 ? liquidGroup : group;
    let longLeg = candidates[0], shortLeg = candidates[0];
    for (const r of candidates) {
      if (r.apr < longLeg.apr) longLeg = r;
      if (r.apr > shortLeg.apr) shortLeg = r;
    }
    if (longLeg === shortLeg) continue;
    const spread = shortLeg.apr - longLeg.apr;
    if (spread < SPREAD_MIN) continue;
    out.push({
      source: "Cross-exchange",
      market,
      category: "cross-exchange-spread",
      apr: spread,
      fixed: false,
      liquid: !!longLeg.liquid && !!shortLeg.liquid,
      longLeg, shortLeg,
    });
  }
  return out;
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
    // Spread rows have their own format — show both legs.
    if (r.category === "cross-exchange-spread" && r.longLeg && r.shortLeg) {
      return `  • <code>${escapeHtml(r.market)}</code> — <b>${apr}%</b> · long ${escapeHtml(r.longLeg.source)} (${r.longLeg.apr.toFixed(2)}%) + short ${escapeHtml(r.shortLeg.source)} (${r.shortLeg.apr.toFixed(2)}%)`;
    }
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
    // Binance excluded — blocked in user's region (RU/CIS).
    fetchBybit(), fetchHyperliquid(),
    fetchMexcFunding(), fetchGateFunding(), fetchHtxFunding(),
    fetchDefiLlama(),
  ]);
  const rows = [];
  const failures = [];
  for (const r of results) {
    if (r.ok) rows.push(...r.data);
    else failures.push(r);
  }
  // Append synthetic cross-exchange spread rows so the alert rule can fire.
  rows.push(...computeCrossExchangeSpreads(rows));
  return { rows, failures };
}

async function runAlerts() {
  console.log("Fetching for alerts…");
  const { rows, failures } = await fetchAll();
  console.log(`Got ${rows.length} rows; failures: ${failures.length}`);
  for (const f of failures) console.warn(`  ${f.source}: ${f.error}`);

  // Append to historical record before triggering alerts — even if alert
  // logic fails (e.g. Telegram down), we still capture the snapshot.
  try {
    await recordHistorySnapshot(rows);
  } catch (err) {
    console.warn("[history] Failed to record snapshot:", err.message);
  }

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
