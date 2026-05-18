#!/usr/bin/env node
//
// Read-only position scanner. Pulls open positions and recent fills from
// Binance, Bybit, and Hyperliquid using the user's API credentials, then
// posts a single consolidated summary to Telegram.
//
// Security model:
//   * Secrets live ONLY in GitHub Actions secrets (encrypted at rest).
//   * This script reads them via process.env, signs each request locally
//     in the runner, never persists them, never logs them.
//   * READ-ONLY keys are required (no trading, no withdrawal). If the user
//     accidentally enables withdrawal on the key, this script still only
//     calls GET endpoints — but ENABLE NO WITHDRAW is the right hygiene.
//
// To enable a source, set its env vars in GitHub repo Settings → Secrets.
// Missing creds for a given source silently skip that source — that way
// you can start with just Hyperliquid (which needs only a public address).

import crypto from "node:crypto";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortNum(n, decimals = 2) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return n.toFixed(decimals);
}
function fmtUsd(n) { return `$${shortNum(n)}`; }
function pnlColour(n) { return n >= 0 ? "🟢" : "🔴"; }

function escapeHtml(s) {
  return String(s ?? "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

async function getJson(url, init = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    try { return JSON.parse(body); } catch { throw new Error(`bad JSON: ${body.slice(0, 200)}`); }
  } finally {
    clearTimeout(timer);
  }
}

// ─── Binance USD-M futures (read-only API key) ────────────────────────────────

async function fetchBinance() {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) return null;

  const ts = Date.now();
  const params = `timestamp=${ts}&recvWindow=10000`;
  const sig = crypto.createHmac("sha256", apiSecret).update(params).digest("hex");

  try {
    const [positions, account] = await Promise.all([
      getJson(`https://fapi.binance.com/fapi/v2/positionRisk?${params}&signature=${sig}`, {
        headers: { "X-MBX-APIKEY": apiKey },
      }),
      getJson(`https://fapi.binance.com/fapi/v2/account?${params}&signature=${sig}`, {
        headers: { "X-MBX-APIKEY": apiKey },
      }),
    ]);

    const open = positions
      .filter(p => Math.abs(Number(p.positionAmt)) > 0)
      .map(p => ({
        symbol: p.symbol,
        side: Number(p.positionAmt) > 0 ? "LONG" : "SHORT",
        size: Math.abs(Number(p.positionAmt)),
        entryPrice: Number(p.entryPrice),
        markPrice: Number(p.markPrice),
        unrealizedPnl: Number(p.unRealizedProfit),
        leverage: Number(p.leverage),
        notional: Math.abs(Number(p.positionAmt) * Number(p.markPrice)),
      }));

    return {
      source: "Binance",
      walletBalance: Number(account.totalWalletBalance),
      marginBalance: Number(account.totalMarginBalance),
      unrealizedPnl: Number(account.totalUnrealizedProfit),
      open,
    };
  } catch (err) {
    return { source: "Binance", error: err.message };
  }
}

// ─── Bybit V5 (read-only API key) ─────────────────────────────────────────────

async function fetchBybit() {
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  if (!apiKey || !apiSecret) return null;

  const ts = Date.now();
  const recvWindow = 10000;

  function sign(query) {
    const payload = `${ts}${apiKey}${recvWindow}${query}`;
    return crypto.createHmac("sha256", apiSecret).update(payload).digest("hex");
  }
  async function call(path, query) {
    return getJson(`https://api.bybit.com${path}?${query}`, {
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-SIGN": sign(query),
        "X-BAPI-TIMESTAMP": String(ts),
        "X-BAPI-RECV-WINDOW": String(recvWindow),
      },
    });
  }

  try {
    const [positionsResp, walletResp] = await Promise.all([
      call("/v5/position/list", "category=linear&settleCoin=USDT"),
      call("/v5/account/wallet-balance", "accountType=UNIFIED"),
    ]);

    const positions = positionsResp?.result?.list ?? [];
    const open = positions
      .filter(p => Number(p.size) > 0)
      .map(p => ({
        symbol: p.symbol,
        side: p.side === "Buy" ? "LONG" : "SHORT",
        size: Number(p.size),
        entryPrice: Number(p.avgPrice),
        markPrice: Number(p.markPrice),
        unrealizedPnl: Number(p.unrealisedPnl),
        leverage: Number(p.leverage),
        notional: Number(p.positionValue),
      }));

    const account = walletResp?.result?.list?.[0] ?? {};
    return {
      source: "Bybit",
      walletBalance: Number(account.totalWalletBalance ?? 0),
      marginBalance: Number(account.totalEquity ?? 0),
      unrealizedPnl: open.reduce((s, p) => s + p.unrealizedPnl, 0),
      open,
    };
  } catch (err) {
    return { source: "Bybit", error: err.message };
  }
}

// ─── Hyperliquid (public address — no API key needed) ─────────────────────────

async function fetchHyperliquid() {
  const address = process.env.HYPERLIQUID_ADDRESS;
  if (!address) return null;

  try {
    const data = await getJson("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: address }),
    });

    const open = (data.assetPositions ?? []).map(ap => {
      const p = ap.position;
      const size = Number(p.szi);
      return {
        symbol: p.coin,
        side: size > 0 ? "LONG" : "SHORT",
        size: Math.abs(size),
        entryPrice: Number(p.entryPx),
        markPrice: Number(p.markPx ?? 0),  // may not be present, derive from unrealized PnL
        unrealizedPnl: Number(p.unrealizedPnl),
        leverage: Number(p.leverage?.value ?? 1),
        notional: Math.abs(Number(p.positionValue ?? size * Number(p.entryPx))),
      };
    });

    return {
      source: "Hyperliquid",
      walletBalance: Number(data.marginSummary?.accountValue ?? 0),
      marginBalance: Number(data.marginSummary?.accountValue ?? 0),
      unrealizedPnl: open.reduce((s, p) => s + p.unrealizedPnl, 0),
      open,
    };
  } catch (err) {
    return { source: "Hyperliquid", error: err.message };
  }
}

// ─── Format message ───────────────────────────────────────────────────────────

function formatExchangeBlock(snap) {
  if (snap.error) {
    return `❌ <b>${escapeHtml(snap.source)}</b>: <i>${escapeHtml(snap.error)}</i>`;
  }
  const pnlIcon = pnlColour(snap.unrealizedPnl);
  const head = `${pnlIcon} <b>${escapeHtml(snap.source)}</b> · баланс ${fmtUsd(snap.walletBalance)} · нереализованный PnL ${snap.unrealizedPnl >= 0 ? "+" : ""}${fmtUsd(snap.unrealizedPnl)}`;
  if (snap.open.length === 0) {
    return `${head}\n  <i>открытых позиций нет</i>`;
  }
  const lines = snap.open.map(p => {
    const sideIcon = p.side === "LONG" ? "📈" : "📉";
    const pnlSign = p.unrealizedPnl >= 0 ? "+" : "";
    const pnlPct = p.notional > 0 ? ` (${pnlSign}${((p.unrealizedPnl / p.notional) * 100).toFixed(2)}%)` : "";
    return `  ${sideIcon} <code>${escapeHtml(p.symbol)}</code> ${p.side} · ${shortNum(p.notional)}$ · entry ${shortNum(p.entryPrice, 4)} → mark ${shortNum(p.markPrice, 4)} · PnL ${pnlSign}${fmtUsd(p.unrealizedPnl)}${pnlPct}`;
  });
  return [head, ...lines].join("\n");
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — would have sent:\n" + text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) {
    throw new Error(`Telegram error ${res.status}: ${await res.text()}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Reading positions…");
  const snaps = (await Promise.all([
    fetchBinance(),
    fetchBybit(),
    fetchHyperliquid(),
  ])).filter(Boolean);

  if (snaps.length === 0) {
    console.log("No API credentials or addresses configured. Skipping.");
    return;
  }

  let totalBalance = 0;
  let totalPnl = 0;
  let totalPositions = 0;
  const blocks = [];

  for (const snap of snaps) {
    blocks.push(formatExchangeBlock(snap));
    if (!snap.error) {
      totalBalance += snap.walletBalance;
      totalPnl += snap.unrealizedPnl;
      totalPositions += snap.open.length;
    }
  }

  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  const head = `📋 <b>Soomqa — портфель</b>
<i>${ts} UTC</i>
Всего: ${fmtUsd(totalBalance)} · PnL ${totalPnl >= 0 ? "+" : ""}${fmtUsd(totalPnl)} · открытых позиций: ${totalPositions}`;

  const message = [head, ...blocks].join("\n\n");
  console.log("Sending:\n" + message);
  await sendTelegram(message);
}

main().catch(err => {
  // Never print env vars in the error — mask any token-like strings.
  const safe = String(err.message || err).replace(/[A-Za-z0-9]{32,}/g, "<redacted>");
  console.error("Fatal:", safe);
  process.exit(1);
});
