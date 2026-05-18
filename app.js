// Soomqa frontend — fetches funding rates and DeFi yields from public APIs
// directly from the browser. No backend, no API keys. All sources support CORS.
//
// Architecture: each fetcher returns { ok, data } | { ok: false, source, error }
// so a single failing source doesn't break the whole view.

// ─── Constants ────────────────────────────────────────────────────────────────

const REFRESH_MS = 60_000;

// Annualisation conventions:
//   Binance/Bybit pay funding every 8h → APR = rate * 3 * 365
//   Hyperliquid pays hourly             → APR = rate * 24 * 365
const APR_8H  = 3 * 365;
const APR_1H  = 24 * 365;

const CATEGORY_LABELS = {
  "funding-rate":  { label: "Funding",   badge: "badge-funding" },
  "fixed-yield":   { label: "Fixed",     badge: "badge-fixed" },
  "stable-lending":{ label: "Lending",   badge: "badge-lending" },
  "delta-neutral": { label: "Δ-neutral", badge: "badge-delta" },
  "restaking":     { label: "Restake",   badge: "badge-restake" },
  "leveraged-stable": { label: "Lev stbl", badge: "badge-leveraged" },
};

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function getJson(url, init = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body, timeoutMs = 15000) {
  return getJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs);
}

// ─── Fetchers ─────────────────────────────────────────────────────────────────

// Funding APRs above this are almost always short-lived spikes on thin
// altcoin/equity perp markets — visible but flagged so the user can spot them.
const FUNDING_SPIKE_THRESHOLD = 30;

function fundingNote(apr, period) {
  const base = `${period} funding`;
  if (Math.abs(apr) > FUNDING_SPIKE_THRESHOLD) {
    return `${base} · thin market, mean-reverts fast`;
  }
  return base;
}

// Binance USD-M futures — ALL perpetual markets (typically ~400+).
async function fetchBinance() {
  try {
    const data = await getJson("https://fapi.binance.com/fapi/v1/premiumIndex");
    const rows = data
      // Filter out delivery futures (e.g. _240329); keep only perps.
      .filter(r => !r.symbol.includes("_"))
      .map(r => {
        // Anchor the strip to the END of the symbol — replace() without
        // anchoring would corrupt names like "USDTUSDC" or "1000USDT".
        const quote = r.symbol.endsWith("USDC") ? "USDC" : "USDT";
        const base = r.symbol.replace(new RegExp(`${quote}$`), "");
        const apr = Number(r.lastFundingRate) * APR_8H * 100;
        return {
          source: "Binance",
          market: base,
          quote,
          category: "funding-rate",
          apr,
          fixed: false,
          note: fundingNote(apr, "8h"),
        };
      });
    return { ok: true, data: rows };
  } catch (err) {
    return { ok: false, source: "Binance", error: err.message };
  }
}

// Bybit V5 linear perps — ALL markets.
async function fetchBybit() {
  try {
    const data = await getJson("https://api.bybit.com/v5/market/tickers?category=linear");
    const rows = (data?.result?.list ?? [])
      .filter(r => r.fundingRate != null && r.fundingRate !== "")
      .map(r => {
        // Bybit linear markets are mostly *USDT, with a handful of inverse-named
        // PERP markets (e.g. "BTCPERP" for USDC-margined). Strip the suffix only
        // if it sits at the end of the symbol.
        let market = r.symbol;
        let quote = "USDT";
        if (market.endsWith("PERP")) {
          market = market.replace(/PERP$/, "");
          quote = "USDC";
        } else if (market.endsWith("USDT")) {
          market = market.replace(/USDT$/, "");
        }
        const apr = Number(r.fundingRate) * APR_8H * 100;
        return {
          source: "Bybit",
          market,
          quote,
          category: "funding-rate",
          apr,
          fixed: false,
          note: fundingNote(apr, "8h"),
        };
      });
    return { ok: true, data: rows };
  } catch (err) {
    return { ok: false, source: "Bybit", error: err.message };
  }
}

// Hyperliquid — all listed perp markets, hourly funding.
async function fetchHyperliquid() {
  try {
    const data = await postJson("https://api.hyperliquid.xyz/info", { type: "metaAndAssetCtxs" });
    const [meta, ctxs] = data;
    const rows = [];
    for (let i = 0; i < meta.universe.length; i++) {
      const asset = meta.universe[i];
      const ctx = ctxs[i];
      if (!asset || !ctx) continue;
      const apr = Number(ctx.funding) * APR_1H * 100;
      rows.push({
        source: "Hyperliquid",
        market: asset.name,
        quote: "USDC",
        category: "funding-rate",
        apr,
        fixed: false,
        note: fundingNote(apr, "1h"),
      });
    }
    return { ok: true, data: rows };
  } catch (err) {
    return { ok: false, source: "Hyperliquid", error: err.message };
  }
}

// DefiLlama aggregated yields — Aave, Morpho, Pendle, Ethena, Sky, etc.
// One endpoint, ~13,000 pools. We filter aggressively here because the raw
// feed includes scam tokens with names like "1337USDC" or "ADPUSDC" that
// show 5-figure APRs and would otherwise pollute the table.

// Symbol whitelists per category. Anything outside this list gets dropped.
// Match is "symbol contains any of these tokens", case-insensitive.
// Lending and delta-neutral are kept tight on purpose — these are pools we'd
// actually consider depositing into, so non-canonical stables must be excluded.
const CANONICAL_STABLES = ["USDC", "USDT", "DAI", "USDS", "USDE", "SUSDE", "SUSDS", "GHO", "PYUSD", "USR", "USDX"];
const CANONICAL_ETH_DERIVS = ["WSTETH", "STETH", "EETH", "EZETH", "RSETH", "PUFETH", "WBETH", "RETH"];

function symbolMatchesAny(symbol, needles) {
  const s = String(symbol ?? "").toUpperCase();
  return needles.some(n => s.includes(n.toUpperCase()));
}

async function fetchDefiLlama() {
  try {
    const resp = await getJson("https://yields.llama.fi/pools");
    if (resp.status !== "success") throw new Error(`bad status: ${resp.status}`);

    // Per-project rules. Tighter TVL floors + symbol whitelist eliminate
    // scam look-alike pools that DefiLlama lists indiscriminately.
    const PROJECT_RULES = [
      // Stable lending — only canonical stables, $50M+ TVL
      { project: "aave-v3",       minTvl: 50_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Aave v3",      note: "instant withdraw, low risk" },
      { project: "aave-v2",       minTvl: 50_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Aave v2",      note: "legacy market" },
      { project: "compound-v3",   minTvl: 30_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Compound v3",  note: "isolated markets" },
      { project: "morpho-blue",   minTvl: 50_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Morpho Blue",  note: "check curator before deposit" },
      { project: "spark",         minTvl: 50_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Spark",        note: "DAI savings rate" },
      { project: "sky-lending",   minTvl: 50_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Sky sUSDS",    note: "governance-managed savings" },
      // Fixed yield (Pendle PT/YT). No symbol whitelist — Pendle constantly
      // launches PTs on new vault tokens (e.g. AVLT, LBTC) that aren't in any
      // canonical list. TVL floor + APR cap below filter the junk.
      { project: "pendle",        minTvl: 5_000_000,   symbols: null,               category: "fixed-yield",    source: "Pendle",       note: "locked to maturity" },
      // Delta-neutral
      { project: "ethena-usde",   minTvl: 100_000_000, symbols: ["USDE", "SUSDE"],  category: "delta-neutral",  source: "Ethena",       note: "packaged funding arb" },
      // Restaking — by underlying LST/LRT
      { project: "eigenlayer",    minTvl: 100_000_000, symbols: CANONICAL_ETH_DERIVS, category: "restaking",   source: "EigenLayer",   note: "AVS yield + slashing risk" },
      { project: "ether.fi-stake",minTvl: 100_000_000, symbols: ["EETH", "WEETH"],  category: "restaking",      source: "Ether.fi eETH",note: "liquid restaking" },
      { project: "renzo",         minTvl: 50_000_000,  symbols: ["EZETH"],          category: "restaking",      source: "Renzo ezETH",  note: "liquid restaking" },
      { project: "kelp-dao",      minTvl: 50_000_000,  symbols: ["RSETH"],          category: "restaking",      source: "Kelp rsETH",   note: "liquid restaking" },
      { project: "puffer-finance",minTvl: 50_000_000,  symbols: ["PUFETH"],         category: "restaking",      source: "Puffer pufETH",note: "anti-slashing LRT" },
    ];

    // Hard sanity cap. Anything above this is almost certainly an emission
    // farm on a worthless token, not a real yield. Real DeFi APYs maxed out
    // around 60-80% on legit pools even in peak bull markets.
    const MAX_REALISTIC_APR = 200;

    const rows = [];
    for (const rule of PROJECT_RULES) {
      const pools = resp.data
        .filter(p => p.project === rule.project)
        .filter(p => (p.tvlUsd ?? 0) >= rule.minTvl)
        .filter(p => p.apy != null && p.apy > 0 && p.apy <= MAX_REALISTIC_APR)
        .filter(p => rule.symbols === null || symbolMatchesAny(p.symbol, rule.symbols));

      for (const p of pools) {
        rows.push({
          source: rule.source,
          market: `${p.symbol} (${shortChain(p.chain)})`,
          quote: "",
          category: rule.category,
          apr: p.apy,
          fixed: rule.category === "fixed-yield",
          note: rule.note,
          tvl: p.tvlUsd,
        });
      }
    }
    return { ok: true, data: rows };
  } catch (err) {
    return { ok: false, source: "DefiLlama", error: err.message };
  }
}

function shortChain(chain) {
  const map = {
    Ethereum: "ETH", Arbitrum: "ARB", Optimism: "OP", Base: "BASE",
    Polygon: "MATIC", BSC: "BSC", Avalanche: "AVAX", Mantle: "MNT",
    Linea: "LINEA", Scroll: "SCR", Blast: "BLAST",
  };
  return map[chain] ?? chain;
}

// ─── State + render ───────────────────────────────────────────────────────────

// Filters survive page reloads — funding rates change often, but the user's
// "show me only USDC lending above 8%" intent doesn't.
const STORAGE_KEY = "soomqa.filters.v1";
function loadFilters() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      search: String(parsed.search ?? ""),
      category: String(parsed.category ?? ""),
      minApr: parsed.minApr === null || parsed.minApr === undefined ? null : Number(parsed.minApr),
      maxApr: parsed.maxApr === null || parsed.maxApr === undefined ? null : Number(parsed.maxApr),
      sort: String(parsed.sort ?? "apr-desc"),
    };
  } catch {
    return null;
  }
}
function saveFilters() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.filters)); } catch {}
}

const state = {
  rows: [],
  failures: [],
  lastUpdated: null,
  filters: loadFilters() ?? { search: "", category: "", minApr: null, maxApr: null, sort: "apr-desc" },
};

const els = {
  rows: document.getElementById("rows"),
  search: document.getElementById("search"),
  category: document.getElementById("category-filter"),
  sort: document.getElementById("sort-by"),
  minApr: document.getElementById("min-apr"),
  maxApr: document.getElementById("max-apr"),
  refresh: document.getElementById("refresh"),
  lastUpdated: document.getElementById("last-updated"),
  errors: document.getElementById("errors"),
  errorsList: document.getElementById("errors-list"),
  sum: {
    bestApr: document.getElementById("sum-best-apr"),
    bestSrc: document.getElementById("sum-best-src"),
    fixedApr: document.getElementById("sum-fixed-apr"),
    fixedSrc: document.getElementById("sum-fixed-src"),
    stableApr: document.getElementById("sum-stable-apr"),
    stableSrc: document.getElementById("sum-stable-src"),
    count: document.getElementById("sum-count"),
    sources: document.getElementById("sum-sources"),
  },
};

function aprColourClass(apr) {
  if (apr < 0) return "apr-neg";
  if (apr >= 15) return "apr-high";
  if (apr >= 8)  return "apr-good";
  if (apr >= 3)  return "apr-mid";
  return "apr-low";
}

function fmtApr(apr) {
  return `${apr >= 0 ? "" : "−"}${Math.abs(apr).toFixed(2)}%`;
}

function applyFilters(rows) {
  const { search, category, minApr, maxApr, sort } = state.filters;
  let out = rows;

  if (search) {
    const q = search.toLowerCase();
    out = out.filter(r =>
      r.market.toLowerCase().includes(q) ||
      r.source.toLowerCase().includes(q),
    );
  }
  if (category) {
    out = out.filter(r => r.category === category);
  }
  if (minApr !== null && !Number.isNaN(minApr)) {
    out = out.filter(r => r.apr >= minApr);
  }
  if (maxApr !== null && !Number.isNaN(maxApr)) {
    out = out.filter(r => r.apr <= maxApr);
  }

  switch (sort) {
    case "apr-desc": out = [...out].sort((a, b) => b.apr - a.apr); break;
    case "apr-asc":  out = [...out].sort((a, b) => a.apr - b.apr); break;
    case "source":   out = [...out].sort((a, b) => a.source.localeCompare(b.source) || b.apr - a.apr); break;
    case "market":   out = [...out].sort((a, b) => a.market.localeCompare(b.market) || b.apr - a.apr); break;
  }
  return out;
}

function render() {
  const filtered = applyFilters(state.rows);

  // Summary cards. Use only sustainable yields here — anything above ~30% APR
  // is either an emission farm, a thin-market funding spike (e.g. equity perps
  // like DIS/USDT, CSCO/USDT, or memecoin perps GWEI/LITE), or a points farm.
  // None of those are honest "best yield right now" signals. They still appear
  // in the table; the cards just don't pretend they're achievable.
  const SUMMARY_APR_CAP = 30;
  const sustainable = state.rows.filter(r => r.apr <= SUMMARY_APR_CAP);

  if (state.rows.length > 0) {
    if (sustainable.length > 0) {
      const best = sustainable.reduce((a, b) => b.apr > a.apr ? b : a);
      els.sum.bestApr.textContent = fmtApr(best.apr);
      els.sum.bestApr.className = `text-xl font-semibold mt-1 font-mono ${aprColourClass(best.apr)}`;
      els.sum.bestSrc.textContent = `${best.source} · ${best.market}`;
    }

    const fixed = sustainable.filter(r => r.fixed);
    if (fixed.length > 0) {
      const bestFixed = fixed.reduce((a, b) => b.apr > a.apr ? b : a);
      els.sum.fixedApr.textContent = fmtApr(bestFixed.apr);
      els.sum.fixedApr.className = `text-xl font-semibold mt-1 font-mono ${aprColourClass(bestFixed.apr)}`;
      els.sum.fixedSrc.textContent = `${bestFixed.source} · ${bestFixed.market}`;
    }

    const stable = sustainable.filter(r => r.category === "stable-lending");
    if (stable.length > 0) {
      const bestStable = stable.reduce((a, b) => b.apr > a.apr ? b : a);
      els.sum.stableApr.textContent = fmtApr(bestStable.apr);
      els.sum.stableApr.className = `text-xl font-semibold mt-1 font-mono ${aprColourClass(bestStable.apr)}`;
      els.sum.stableSrc.textContent = `${bestStable.source} · ${bestStable.market}`;
    }

    els.sum.count.textContent = String(state.rows.length);
    const uniqueSources = new Set(state.rows.map(r => r.source));
    els.sum.sources.textContent = `${uniqueSources.size} sources`;
  }

  // Table
  if (filtered.length === 0) {
    els.rows.innerHTML = `<tr><td colspan="6" class="px-3 py-8 text-center text-zinc-500">No markets match your filters.</td></tr>`;
  } else {
    const html = filtered.slice(0, 500).map(r => {
      const cat = CATEGORY_LABELS[r.category] ?? { label: r.category, badge: "" };
      const colour = aprColourClass(r.apr);
      return `
        <tr>
          <td class="px-3 py-2 text-zinc-300">${escapeHtml(r.source)}</td>
          <td class="px-3 py-2 font-mono text-xs text-zinc-100">${escapeHtml(r.market)}${r.quote ? `<span class="text-zinc-500">/${escapeHtml(r.quote)}</span>` : ""}</td>
          <td class="px-3 py-2 hidden sm:table-cell"><span class="badge ${cat.badge}">${cat.label}</span></td>
          <td class="px-3 py-2 text-right font-mono ${colour}">${fmtApr(r.apr)}</td>
          <td class="px-3 py-2 hidden md:table-cell text-zinc-400 text-xs">${r.fixed ? "fixed" : "variable"}</td>
          <td class="px-3 py-2 hidden lg:table-cell text-zinc-500 text-xs">${escapeHtml(r.note ?? "")}</td>
        </tr>
      `;
    }).join("");
    els.rows.innerHTML = html;
    if (filtered.length > 500) {
      els.rows.insertAdjacentHTML("beforeend",
        `<tr><td colspan="6" class="px-3 py-3 text-center text-zinc-500 text-xs">Showing top 500 of ${filtered.length} — narrow your filter to see more.</td></tr>`);
    }
  }

  // Errors panel
  if (state.failures.length > 0) {
    els.errors.classList.remove("hidden");
    els.errorsList.innerHTML = state.failures
      .map(f => `<li><strong>${escapeHtml(f.source)}</strong>: ${escapeHtml(f.error)}</li>`)
      .join("");
  } else {
    els.errors.classList.add("hidden");
  }

  // Updated timestamp
  if (state.lastUpdated) {
    els.lastUpdated.textContent = `Updated ${formatRelativeTime(state.lastUpdated)}`;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatRelativeTime(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return new Date(ts).toLocaleTimeString();
}

// ─── Refresh loop ─────────────────────────────────────────────────────────────

async function refreshData() {
  els.refresh.disabled = true;
  els.refresh.textContent = "↻ Loading…";

  const results = await Promise.all([
    fetchBinance(),
    fetchBybit(),
    fetchHyperliquid(),
    fetchDefiLlama(),
  ]);

  const rows = [];
  const failures = [];
  for (const r of results) {
    if (r.ok) rows.push(...r.data);
    else failures.push({ source: r.source, error: r.error });
  }

  state.rows = rows;
  state.failures = failures;
  state.lastUpdated = Date.now();
  render();

  els.refresh.disabled = false;
  els.refresh.textContent = "↻ Refresh";
}

// ─── Wire up listeners ────────────────────────────────────────────────────────

// Debounce text inputs so we don't re-render on every keystroke.
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Restore filter values into the inputs before wiring listeners.
els.search.value = state.filters.search;
els.category.value = state.filters.category;
els.sort.value = state.filters.sort;
els.minApr.value = state.filters.minApr ?? "";
els.maxApr.value = state.filters.maxApr ?? "";

const onSearch = debounce(e => {
  state.filters.search = e.target.value.trim();
  saveFilters();
  render();
}, 150);
const onMinApr = debounce(e => {
  const v = e.target.value === "" ? null : Number(e.target.value);
  state.filters.minApr = Number.isNaN(v) ? null : v;
  saveFilters();
  render();
}, 150);
const onMaxApr = debounce(e => {
  const v = e.target.value === "" ? null : Number(e.target.value);
  state.filters.maxApr = Number.isNaN(v) ? null : v;
  saveFilters();
  render();
}, 150);

els.search.addEventListener("input", onSearch);
els.minApr.addEventListener("input", onMinApr);
els.maxApr.addEventListener("input", onMaxApr);
els.category.addEventListener("change", e => {
  state.filters.category = e.target.value;
  saveFilters();
  render();
});
els.sort.addEventListener("change", e => {
  state.filters.sort = e.target.value;
  saveFilters();
  render();
});
els.refresh.addEventListener("click", refreshData);

// Refresh timer that pauses when the tab is hidden, so we don't burn the
// user's mobile battery polling for funding rates they aren't looking at.
let refreshTimer = null;
function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(refreshData, REFRESH_MS);
}
function stopRefreshTimer() {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    // If we've been away long enough that data is stale, refresh now too.
    if (state.lastUpdated && Date.now() - state.lastUpdated > 30_000) {
      refreshData();
    }
    startRefreshTimer();
  } else {
    stopRefreshTimer();
  }
});

// Live timer for "X seconds ago"
setInterval(() => {
  if (state.lastUpdated) els.lastUpdated.textContent = `Updated ${formatRelativeTime(state.lastUpdated)}`;
}, 5000);

// Initial fetch + periodic refresh
refreshData();
startRefreshTimer();
