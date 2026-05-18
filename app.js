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
  "fixed-yield":   { label: "Фикс.",     badge: "badge-fixed" },
  "stable-lending":{ label: "Лендинг",   badge: "badge-lending" },
  "delta-neutral": { label: "Δ-нейтрал", badge: "badge-delta" },
  "restaking":     { label: "Рестейк",   badge: "badge-restake" },
  "leveraged-stable": { label: "Лев. стейбл", badge: "badge-leveraged" },
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
//
// Each row carries a `liquid` boolean. A row is liquid when there's enough real
// trading / TVL behind it that the headline APR isn't going to mean-revert
// inside a day. The signal driving `liquid` differs by source:
//
//   CEX funding: 24h quote volume + open interest in USD
//   DeFi yields: TVL + whether `apyBase` (real yield) is the bulk of the APR
//                vs `apyReward` (token emissions that decay fast) + the
//                `outlier` flag DefiLlama already publishes
//
// No hardcoded percentage thresholds on APR itself — the page surfaces every
// market, with the `liquid` flag deciding which feed into summary cards and
// which get the "thin market" annotation in the table.

// Minimum 24h quote volume (in USD) for a perp to be considered deep enough
// that funding is a sustainable signal. $10M/day is a sane floor: BTC/ETH are
// in the tens of billions, mid-cap alts hit $50M-$1B, and equity/memecoin
// perps that produce the 300%+ funding spikes sit below.
const PERP_LIQUID_VOLUME_USD = 10_000_000;

// Open interest (USD) backstop in case volume is briefly unrepresentative
// (e.g. weekend). At least one of the two has to clear the floor.
const PERP_LIQUID_OI_USD = 5_000_000;

function makePerpRow({ source, market, quote, apr, period, volumeUsd, openInterestUsd }) {
  const liquid = (volumeUsd >= PERP_LIQUID_VOLUME_USD) ||
                 (openInterestUsd >= PERP_LIQUID_OI_USD);
  const noteParts = [`${period} funding`];
  if (!liquid) {
    noteParts.push("тонкая ликвидность — APR быстро меняется");
  } else if (volumeUsd > 0) {
    noteParts.push(`оборот ${formatUsdShort(volumeUsd)}/24ч`);
  }
  return {
    source, market, quote,
    category: "funding-rate",
    apr,
    fixed: false,
    liquid,
    note: noteParts.join(" · "),
    volumeUsd, openInterestUsd,
  };
}

function formatUsdShort(v) {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

// Binance USD-M futures — funding rate + 24h volume, joined by symbol.
// Two parallel calls so we get both data points in one render pass.
async function fetchBinance() {
  try {
    const [funding, tickers] = await Promise.all([
      getJson("https://fapi.binance.com/fapi/v1/premiumIndex"),
      getJson("https://fapi.binance.com/fapi/v1/ticker/24hr"),
    ]);
    const volumeBy = new Map();
    for (const t of tickers) {
      // `quoteVolume` is volume measured in the quote asset (USDT/USDC),
      // i.e. already in USD-ish terms.
      volumeBy.set(t.symbol, Number(t.quoteVolume) || 0);
    }
    const rows = funding
      .filter(r => !r.symbol.includes("_"))  // drop delivery futures
      .map(r => {
        const quote = r.symbol.endsWith("USDC") ? "USDC" : "USDT";
        const market = r.symbol.replace(new RegExp(`${quote}$`), "");
        const apr = Number(r.lastFundingRate) * APR_8H * 100;
        return makePerpRow({
          source: "Binance",
          market, quote, apr, period: "8h",
          volumeUsd: volumeBy.get(r.symbol) ?? 0,
          openInterestUsd: 0,  // Binance OI is a separate per-symbol call; skip for now.
        });
      });
    return { ok: true, data: rows };
  } catch (err) {
    return { ok: false, source: "Binance", error: err.message };
  }
}

// Bybit V5 linear perps. The /tickers response already includes 24h turnover
// AND open interest value — no second call needed.
async function fetchBybit() {
  try {
    const data = await getJson("https://api.bybit.com/v5/market/tickers?category=linear");
    const rows = (data?.result?.list ?? [])
      .filter(r => r.fundingRate != null && r.fundingRate !== "")
      .map(r => {
        let market = r.symbol;
        let quote = "USDT";
        if (market.endsWith("PERP")) {
          market = market.replace(/PERP$/, "");
          quote = "USDC";
        } else if (market.endsWith("USDT")) {
          market = market.replace(/USDT$/, "");
        }
        const apr = Number(r.fundingRate) * APR_8H * 100;
        return makePerpRow({
          source: "Bybit",
          market, quote, apr, period: "8h",
          volumeUsd: Number(r.turnover24h) || 0,
          openInterestUsd: Number(r.openInterestValue) || 0,
        });
      });
    return { ok: true, data: rows };
  } catch (err) {
    return { ok: false, source: "Bybit", error: err.message };
  }
}

// Hyperliquid — `metaAndAssetCtxs` already includes daily notional volume
// and open interest per market.
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
      const markPx = Number(ctx.markPx) || 0;
      // openInterest on HL is in base units; convert with mark price.
      const oiUsd = (Number(ctx.openInterest) || 0) * markPx;
      rows.push(makePerpRow({
        source: "Hyperliquid",
        market: asset.name,
        quote: "USDC",
        apr, period: "1h",
        // `dayNtlVlm` is already in USD (notional volume).
        volumeUsd: Number(ctx.dayNtlVlm) || 0,
        openInterestUsd: oiUsd,
      }));
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
    // scam look-alike pools that DefiLlama lists indiscriminately. There's no
    // longer a hardcoded APR cap — sustainability is judged from `apyBase`
    // (real yield), `apyMean30d` (smoothed), and the `outlier` flag.
    const PROJECT_RULES = [
      // Stable lending — only canonical stables, $50M+ TVL
      { project: "aave-v3",       minTvl: 50_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Aave v3",      note: "мгновенный вывод, низкий риск" },
      { project: "aave-v2",       minTvl: 50_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Aave v2",      note: "старая версия рынка" },
      { project: "compound-v3",   minTvl: 30_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Compound v3",  note: "изолированные рынки" },
      { project: "morpho-blue",   minTvl: 50_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Morpho Blue",  note: "проверь куратора перед депозитом" },
      { project: "spark",         minTvl: 50_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Spark",        note: "DAI savings rate" },
      { project: "sky-lending",   minTvl: 50_000_000,  symbols: CANONICAL_STABLES, category: "stable-lending", source: "Sky sUSDS",    note: "ставка управляется DAO" },
      // Fixed yield. No symbol whitelist — Pendle constantly launches PTs on
      // new vault tokens that aren't in any canonical list.
      { project: "pendle",        minTvl: 5_000_000,   symbols: null,               category: "fixed-yield",    source: "Pendle",       note: "доходность зафиксирована до даты" },
      // Delta-neutral
      { project: "ethena-usde",   minTvl: 100_000_000, symbols: ["USDE", "SUSDE"],  category: "delta-neutral",  source: "Ethena",       note: "упакованный funding arb" },
      // Restaking — by underlying LST/LRT
      { project: "eigenlayer",    minTvl: 100_000_000, symbols: CANONICAL_ETH_DERIVS, category: "restaking",   source: "EigenLayer",   note: "AVS доходность + риск слэша" },
      { project: "ether.fi-stake",minTvl: 100_000_000, symbols: ["EETH", "WEETH"],  category: "restaking",      source: "Ether.fi eETH",note: "ликвидный рестейкинг" },
      { project: "renzo",         minTvl: 50_000_000,  symbols: ["EZETH"],          category: "restaking",      source: "Renzo ezETH",  note: "ликвидный рестейкинг" },
      { project: "kelp-dao",      minTvl: 50_000_000,  symbols: ["RSETH"],          category: "restaking",      source: "Kelp rsETH",   note: "ликвидный рестейкинг" },
      { project: "puffer-finance",minTvl: 50_000_000,  symbols: ["PUFETH"],         category: "restaking",      source: "Puffer pufETH",note: "LRT с защитой от слэша" },
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

        // Liquid = enough TVL + we have a base yield component (real interest
        // or RWA yield, not just emissions) OR the 30-day mean confirms the
        // headline APR isn't a fresh spike. The DefiLlama `outlier` flag is
        // an explicit "trust us, this is anomalous" — always reject those.
        const tvl = Number(p.tvlUsd) || 0;
        const baseDominates = apyBase != null && apyBase >= apr * 0.5;
        const smoothedAgrees = apyMean30d != null && apyMean30d >= apr * 0.6;
        const tvlSubstantial = tvl >= rule.minTvl * 2;  // double the rule's floor
        const liquid = !p.outlier && (baseDominates || smoothedAgrees) && tvlSubstantial;

        const noteParts = [rule.note];
        if (apyBase != null && apyReward != null && apyReward > apyBase) {
          noteParts.push(`${apyBase.toFixed(1)}% база + ${apyReward.toFixed(1)}% эмиссии`);
        }
        if (apyMean30d != null && apr > apyMean30d * 1.5) {
          noteParts.push(`выше среднего за 30 дн (${apyMean30d.toFixed(1)}%)`);
        }
        if (tvl > 0) {
          noteParts.push(`TVL ${formatUsdShort(tvl)}`);
        }

        rows.push({
          source: rule.source,
          market: `${p.symbol} (${shortChain(p.chain)})`,
          quote: "",
          category: rule.category,
          apr,
          fixed: rule.category === "fixed-yield",
          liquid,
          note: noteParts.join(" · "),
          tvl,
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
      liquidOnly: Boolean(parsed.liquidOnly),
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
  filters: loadFilters() ?? { search: "", category: "", minApr: null, maxApr: null, liquidOnly: false, sort: "apr-desc" },
};

const els = {
  rows: document.getElementById("rows"),
  search: document.getElementById("search"),
  category: document.getElementById("category-filter"),
  sort: document.getElementById("sort-by"),
  minApr: document.getElementById("min-apr"),
  maxApr: document.getElementById("max-apr"),
  liquidOnly: document.getElementById("liquid-only"),
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
  const { search, category, minApr, maxApr, liquidOnly, sort } = state.filters;
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
  if (liquidOnly) {
    out = out.filter(r => r.liquid);
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

  // Summary cards. Use only rows the fetchers marked `liquid` — that's the
  // app's signal that the APR is backed by real volume/TVL and isn't a thin-
  // market spike. Every market is still in the table; the cards just don't
  // claim a 300% memecoin funding rate is "best overall".
  const sustainable = state.rows.filter(r => r.liquid);

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
    els.sum.sources.textContent = `${uniqueSources.size} источников`;
  }

  // Table
  if (filtered.length === 0) {
    els.rows.innerHTML = `<tr><td colspan="6" class="px-3 py-8 text-center text-zinc-500">Под фильтры ничего не подошло.</td></tr>`;
  } else {
    const html = filtered.slice(0, 500).map(r => {
      const cat = CATEGORY_LABELS[r.category] ?? { label: r.category, badge: "" };
      const colour = aprColourClass(r.apr);
      const rowOpacity = r.liquid === false ? "opacity-70" : "";
      const marketBadge = r.liquid === false
        ? `<span class="ml-1 text-[10px] text-amber-400/70" title="Тонкий рынок — APR быстро меняется">●</span>`
        : "";
      return `
        <tr class="${rowOpacity}">
          <td class="px-3 py-2 text-zinc-300">${escapeHtml(r.source)}</td>
          <td class="px-3 py-2 font-mono text-xs text-zinc-100">${escapeHtml(r.market)}${r.quote ? `<span class="text-zinc-500">/${escapeHtml(r.quote)}</span>` : ""}${marketBadge}</td>
          <td class="px-3 py-2 hidden sm:table-cell"><span class="badge ${cat.badge}">${cat.label}</span></td>
          <td class="px-3 py-2 text-right font-mono ${colour}">${fmtApr(r.apr)}</td>
          <td class="px-3 py-2 hidden md:table-cell text-zinc-400 text-xs">${r.fixed ? "фикс" : "плав"}</td>
          <td class="px-3 py-2 hidden lg:table-cell text-zinc-500 text-xs">${escapeHtml(r.note ?? "")}</td>
        </tr>
      `;
    }).join("");
    els.rows.innerHTML = html;
    if (filtered.length > 500) {
      els.rows.insertAdjacentHTML("beforeend",
        `<tr><td colspan="6" class="px-3 py-3 text-center text-zinc-500 text-xs">Показано 500 из ${filtered.length} — уточните фильтр, чтобы увидеть больше.</td></tr>`);
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
    els.lastUpdated.textContent = `Обновлено ${formatRelativeTime(state.lastUpdated)}`;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatRelativeTime(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 5) return "только что";
  if (sec < 60) return `${sec} сек назад`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин назад`;
  return new Date(ts).toLocaleTimeString("ru-RU");
}

// ─── Refresh loop ─────────────────────────────────────────────────────────────

async function refreshData() {
  els.refresh.disabled = true;
  els.refresh.textContent = "↻ Загрузка…";

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
  els.refresh.textContent = "↻ Обновить";
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
els.liquidOnly.checked = state.filters.liquidOnly;

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
els.liquidOnly.addEventListener("change", e => {
  state.filters.liquidOnly = e.target.checked;
  saveFilters();
  render();
});
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
  if (state.lastUpdated) els.lastUpdated.textContent = `Обновлено ${formatRelativeTime(state.lastUpdated)}`;
}, 5000);

// Initial fetch + periodic refresh
refreshData();
startRefreshTimer();
