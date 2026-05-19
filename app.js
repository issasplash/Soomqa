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
  "cross-exchange-spread": { label: "Cross-spread", badge: "badge-spread" },
};

// One-paragraph description of each strategy so the user knows what kind of
// trade each group represents — what they're committing to, what the risks are.
const CATEGORY_DESCRIPTIONS = {
  "stable-lending": {
    emoji: "🏦",
    title: "Лендинг стейблов",
    desc: "Положил USDC/USDT/DAI в DeFi-пул → получаешь yield. Мгновенный вывод, самая безопасная стратегия.",
  },
  "fixed-yield": {
    emoji: "📜",
    title: "Фикс. доходность (Pendle PT)",
    desc: "Покупаешь PT-токен с дисконтом → на maturity он стоит полную цену = фиксированный yield. Деньги залочены до даты.",
  },
  "delta-neutral": {
    emoji: "⚖️",
    title: "Δ-нейтрал (Ethena)",
    desc: "Готовая funding-arb стратегия в одном токене. Yield variable, зависит от рынка perp.",
  },
  "restaking": {
    emoji: "🧱",
    title: "Рестейкинг (LRT)",
    desc: "Стейкаешь ETH → базовый yield + AVS rewards + airdrop points. Долгосрочно, риск slashing.",
  },
  "cross-exchange-spread": {
    emoji: "🔀",
    title: "Cross-exchange спред",
    desc: "Long на одной бирже + short на другой = ловишь разницу funding rate. Требует капитал на 2 биржах одновременно.",
  },
  "funding-rate": {
    emoji: "🔄",
    title: "Funding rate (одна биржа)",
    desc: "Активный трейдинг funding rate. На каждой бирже отдельно. Спайки длятся часами — требует мониторинг.",
  },
  "leveraged-stable": {
    emoji: "🔁",
    title: "Leveraged stables",
    desc: "Рекурсивные займы для усиления доходности. Риск ликвидации при депеге.",
  },
};

// Default rows shown per group before user clicks "show all".
const GROUP_DEFAULT_LIMIT = 10;

// ─── Risk score ───────────────────────────────────────────────────────────────
//
// Composite 1–5 score per row. 1 = "класть и забыть", 5 = "знай что делаешь".
// Designed to be readable at a glance — colour-coded dot next to the APR.
//
// Inputs are category default, liquidity flag, APR magnitude, and (optionally)
// spike-vs-average if we have history data cached.

const CATEGORY_BASE_RISK = {
  "stable-lending": 1,
  "fixed-yield":    2,
  "delta-neutral":  3,
  "restaking":      3,
  "leveraged-stable": 4,
  "funding-rate":   4,
  "cross-exchange-spread": 4,
};

function riskScoreFor(row) {
  let score = CATEGORY_BASE_RISK[row.category] ?? 3;
  if (row.liquid === false) score += 1;
  if (row.nonCrypto) score += 1;
  if (Math.abs(row.apr) > 100) score += 1;
  else if (Math.abs(row.apr) > 50) score += 0.5;
  // Spike detection from cached history (if available). historyCache is
  // defined further down the file; guard against TDZ.
  try {
    const hist = historyCache.get(historyCacheKey(row, 7));
    if (hist && hist.points && hist.points.length > 5) {
      const sum = hist.points.reduce((s, p) => s + p.value, 0);
      const avg = sum / hist.points.length;
      if (avg !== 0 && Math.abs(row.apr / avg) > 1.5) score += 0.5;
    }
  } catch { /* historyCache not yet initialised */ }
  return Math.max(1, Math.min(5, Math.round(score)));
}

function riskColourClass(score) {
  return ["risk-1", "risk-2", "risk-3", "risk-4", "risk-5"][score - 1] ?? "risk-3";
}

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

// Some exchanges (MEXC, Gate.io, HTX) don't send the Access-Control-Allow-Origin
// header on their public endpoints, so the browser blocks the fetch. corsproxy.io
// is a public free CORS proxy — we use it ONLY as a fallback (direct first) and
// only for endpoints we already know are read-only public data. Never used for
// signed/authenticated requests.
async function getJsonViaCorsFallback(url, init = {}, timeoutMs = 15000) {
  try {
    return await getJson(url, init, timeoutMs);
  } catch (err) {
    const proxied = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
    return await getJson(proxied, init, timeoutMs);
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

// Basis = (markPrice - indexPrice) / indexPrice — i.e. how far the perp is
// trading above/below spot. A perp with 130% APR funding but no basis means
// funding already paid out; basis > 0.3% means there's still an active spread
// that the next funding cycle will arbitrage away. Treat such markets as
// non-sustainable signals regardless of volume — even Circle/Tesla equity
// perps can briefly clear $50M/day on a news spike.
const PERP_SPIKE_BASIS_THRESHOLD = 0.003;

function makePerpRow({ source, market, quote, apr, period, volumeUsd, openInterestUsd, basis, nonCrypto }) {
  // Sanity bound. No real perpetual funding rate sustains ±500% APR — values
  // above that are virtually always API data errors, abandoned markets, or
  // single-cycle spikes about to revert. We keep the row in the table for
  // visibility but mark it as suspect so it never feeds summary cards or
  // recommendations.
  const SUSPECT_APR = 500;
  const suspect = Math.abs(apr) > SUSPECT_APR;

  const hasDepth = (volumeUsd >= PERP_LIQUID_VOLUME_USD) ||
                   (openInterestUsd >= PERP_LIQUID_OI_USD);
  const inActiveSpike = basis != null && Math.abs(basis) > PERP_SPIKE_BASIS_THRESHOLD;
  const liquid = hasDepth && !inActiveSpike && !nonCrypto && !suspect;

  const noteParts = [`${period} funding`];
  if (suspect) {
    noteParts.push("⚠ аномальная ставка — скорее всего ошибка данных");
  } else if (nonCrypto) {
    noteParts.push("equity/index perp — нет лёгкого хеджа на споте");
  } else if (!hasDepth) {
    noteParts.push("тонкая ликвидность — APR быстро меняется");
  } else if (inActiveSpike) {
    const basisPct = (basis * 100).toFixed(2);
    noteParts.push(`mark выше спота на ${basisPct}% — funding скорректируется`);
  } else if (volumeUsd > 0) {
    noteParts.push(`оборот ${formatUsdShort(volumeUsd)}/24ч`);
  }
  return {
    source, market, quote,
    category: "funding-rate",
    apr,
    fixed: false,
    liquid,
    suspect,
    note: noteParts.join(" · "),
    volumeUsd, openInterestUsd, basis, nonCrypto,
  };
}

function formatUsdShort(v) {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

// Binance USD-M futures — funding rate + 24h volume + contract metadata.
// Three parallel calls: rates, tickers, and exchangeInfo (which tells us
// which symbols are equity/index perps vs pure crypto perps — Binance
// surfaces this via underlyingType=COIN/INDEX/STOCK and pairs like SNDK,
// CRCL, QQQ, GOOGL that produce structurally high funding without any
// concept of "spot" available to retail crypto users).
async function fetchBinance() {
  try {
    const [funding, tickers, info] = await Promise.all([
      getJson("https://fapi.binance.com/fapi/v1/premiumIndex"),
      getJson("https://fapi.binance.com/fapi/v1/ticker/24hr"),
      getJson("https://fapi.binance.com/fapi/v1/exchangeInfo"),
    ]);
    const volumeBy = new Map();
    for (const t of tickers) {
      volumeBy.set(t.symbol, Number(t.quoteVolume) || 0);
    }
    // Map symbol → { contractType, underlyingType }. Anything not PERPETUAL
    // (delivery futures, dated contracts) is already filtered by us above; the
    // underlyingType is the new signal — "COIN" for crypto, "INDEX"/"STOCK"
    // (or similar) for equity-tracking perps.
    const metaBy = new Map();
    for (const s of (info?.symbols ?? [])) {
      metaBy.set(s.symbol, {
        contractType: s.contractType,
        underlyingType: s.underlyingType,
      });
    }

    const rows = funding
      .filter(r => !r.symbol.includes("_"))
      .map(r => {
        const quote = r.symbol.endsWith("USDC") ? "USDC" : "USDT";
        const market = r.symbol.replace(new RegExp(`${quote}$`), "");
        const apr = Number(r.lastFundingRate) * APR_8H * 100;
        const markPrice = Number(r.markPrice) || 0;
        const indexPrice = Number(r.indexPrice) || 0;
        const basis = indexPrice > 0 ? (markPrice - indexPrice) / indexPrice : null;
        const meta = metaBy.get(r.symbol) ?? {};
        // "COIN" = pure crypto. Anything else (INDEX, STOCK, undefined) we
        // treat as non-canonical and refuse to surface as a sustainable yield.
        const nonCrypto = meta.underlyingType != null && meta.underlyingType !== "COIN";
        return makePerpRow({
          source: "Binance",
          market, quote, apr, period: "8h",
          volumeUsd: volumeBy.get(r.symbol) ?? 0,
          openInterestUsd: 0,
          basis,
          nonCrypto,
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
        // Bybit gives lastPrice + indexPrice; same basis idea.
        const lastPrice = Number(r.lastPrice) || 0;
        const indexPrice = Number(r.indexPrice) || 0;
        const basis = indexPrice > 0 ? (lastPrice - indexPrice) / indexPrice : null;
        return makePerpRow({
          source: "Bybit",
          market, quote, apr, period: "8h",
          volumeUsd: Number(r.turnover24h) || 0,
          openInterestUsd: Number(r.openInterestValue) || 0,
          basis,
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
      const oraclePx = Number(ctx.oraclePx) || 0;
      const basis = oraclePx > 0 ? (markPx - oraclePx) / oraclePx : null;
      // openInterest on HL is in base units; convert with mark price.
      const oiUsd = (Number(ctx.openInterest) || 0) * markPx;
      rows.push(makePerpRow({
        source: "Hyperliquid",
        market: asset.name,
        quote: "USDC",
        apr, period: "1h",
        volumeUsd: Number(ctx.dayNtlVlm) || 0,
        openInterestUsd: oiUsd,
        basis,
      }));
    }
    return { ok: true, data: rows };
  } catch (err) {
    return { ok: false, source: "Hyperliquid", error: err.message };
  }
}

// MEXC contract — public bulk funding endpoint (one call returns all perps).
async function fetchMexcFunding() {
  try {
    const [fundings, tickers] = await Promise.all([
      getJsonViaCorsFallback("https://contract.mexc.com/api/v1/contract/funding_rate/all"),
      getJsonViaCorsFallback("https://contract.mexc.com/api/v1/contract/ticker"),
    ]);
    const volumeBy = new Map();
    for (const t of (tickers?.data ?? [])) {
      // amount24 = 24h turnover in quote currency (USDT)
      volumeBy.set(t.symbol, Number(t.amount24) || 0);
    }
    const rows = (fundings?.data ?? []).map(r => {
      const apr = Number(r.fundingRate ?? 0) * APR_8H * 100;
      const market = r.symbol.replace(/_USDT$/, "");
      return makePerpRow({
        source: "MEXC",
        market,
        quote: "USDT",
        apr,
        period: "8h",
        volumeUsd: volumeBy.get(r.symbol) ?? 0,
        openInterestUsd: 0,
        basis: null,
      });
    });
    return { ok: true, data: rows };
  } catch (err) {
    return { ok: false, source: "MEXC", error: err.message };
  }
}

// Gate.io USDT-margined futures — public, single request returns all
// contracts with funding_rate, mark/index price, and 24h turnover.
async function fetchGateFunding() {
  try {
    const data = await getJsonViaCorsFallback("https://api.gateio.ws/api/v4/futures/usdt/contracts");
    const rows = (Array.isArray(data) ? data : []).map(r => {
      // Clamp interval to a sane range. Some Gate contracts return interval=0
      // or absurdly small values (test/abandoned markets) which makes the APR
      // calculation explode into thousands of percent. Real funding intervals
      // are always between 1 hour and 8 hours.
      const rawInterval = Number(r.funding_interval) || 28800;
      const intervalSec = Math.min(28800, Math.max(3600, rawInterval));
      const periodsPerYear = (365 * 24 * 3600) / intervalSec;
      const apr = Number(r.funding_rate ?? 0) * periodsPerYear * 100;
      const market = r.name.replace(/_USDT$/, "");
      const markPrice = Number(r.mark_price ?? 0);
      const indexPrice = Number(r.index_price ?? 0);
      const basis = indexPrice > 0 ? (markPrice - indexPrice) / indexPrice : null;
      return makePerpRow({
        source: "Gate.io",
        market,
        quote: "USDT",
        apr,
        period: intervalSec === 3600 ? "1h" : "8h",
        volumeUsd: Number(r.trade_size_24h_usd ?? 0),
        openInterestUsd: 0,
        basis,
      });
    });
    return { ok: true, data: rows };
  } catch (err) {
    return { ok: false, source: "Gate.io", error: err.message };
  }
}

// Pendle Boros — tokenised funding rate futures. New (Aug 2025) Pendle
// product that lets you lock in a funding rate as a fixed yield to maturity.
// Effectively closes the "fixed funding rate" gap I missed in earlier
// research. API is still in flux; we treat this fetcher as best-effort.
async function fetchPendleBoros() {
  try {
    // Boros markets endpoint. The exact shape may shift between V1 and V2;
    // we defensively pick the fields we recognise.
    const data = await getJsonViaCorsFallback("https://api-v2.pendle.finance/core/v1/42161/markets?type=BOROS");
    const list = Array.isArray(data?.results) ? data.results
                 : Array.isArray(data?.data) ? data.data
                 : Array.isArray(data) ? data : [];
    const rows = list.map(m => {
      const apr = Number(m.impliedApy ?? m.aprFixed ?? m.fixedApr ?? m.apy ?? 0) * 100;
      const tvl = Number(m.tvl ?? m.totalValueLocked ?? 0);
      // Boros markets have a maturity timestamp — calculate days remaining.
      const maturity = m.maturity ?? m.expiry ?? null;
      const note = maturity
        ? `Boros funding lock · maturity ${String(maturity).slice(0, 10)}`
        : `Boros funding lock`;
      const symbol = m.name ?? m.symbol ?? m.underlyingSymbol ?? "?";
      return {
        source: "Pendle Boros",
        market: symbol,
        quote: "",
        category: "fixed-yield",
        apr,
        fixed: true,
        liquid: tvl >= 1_000_000,
        note,
        tvl,
        poolId: m.address ?? m.id ?? null,
      };
    }).filter(r => r.apr > 0 && r.apr < 200);
    return { ok: true, data: rows };
  } catch (err) {
    return { ok: false, source: "Pendle Boros", error: err.message };
  }
}

// HTX (formerly Huobi) linear USDT swaps — public batch endpoint.
async function fetchHtxFunding() {
  try {
    const data = await getJsonViaCorsFallback("https://api.hbdm.com/linear-swap-api/v1/swap_batch_funding_rate");
    const rows = (data?.data ?? []).map(r => {
      const apr = Number(r.funding_rate ?? 0) * APR_8H * 100;
      const market = r.contract_code.replace(/-USDT$/, "");
      return makePerpRow({
        source: "HTX",
        market,
        quote: "USDT",
        apr,
        period: "8h",
        volumeUsd: 0,
        openInterestUsd: 0,
        basis: null,
      });
    });
    return { ok: true, data: rows };
  } catch (err) {
    return { ok: false, source: "HTX", error: err.message };
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
          // DefiLlama gives each pool a stable UUID — we keep it on the row
          // so the history loader can call /chart/{poolId} later.
          poolId: p.pool,
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
      watchlistOnly: Boolean(parsed.watchlistOnly),
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
  filters: loadFilters() ?? { search: "", category: "", minApr: null, maxApr: null, liquidOnly: false, watchlistOnly: false, sort: "apr-desc" },
  visibleRows: [],
  expandedRowIndex: null,
  // APR history: rowKey → last known APR. Diffed each refresh to show ↑/↓ arrows.
  previousApr: new Map(),
  // Group view state: which category headers are collapsed, which had "show
  // all" clicked. Both persist across renders so the user doesn't lose context
  // when refreshData repaints.
  collapsedGroups: new Set(),
  showAllGroups: new Set(),
};

// ─── Positions (Phase 3: track what you actually deposited) ──────────────────
//
// A position is a snapshot: user clicks "Добавить как позицию" in a row's
// calculator, we record (rowKey, amount, apr_at_open, opened_at) into
// localStorage. The positions panel at the top of the page then projects how
// much that position has earned since opening, using a simple linear model:
//
//   earned ≈ amount × apr_at_open × (days_held / 365)
//
// Caveats acknowledged in the UI: this is an estimate. Real value depends on
// compound vs simple accrual, actual exit fees, depeg events, and the live
// APR (which may diverge from the snapshot). The user should periodically
// verify against the protocol/exchange UI. The tracker exists to give
// directionally correct intuition, not bookkeeping accuracy.

const POSITIONS_KEY = "soomqa.positions.v1";

function loadPositions() {
  try {
    const raw = localStorage.getItem(POSITIONS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function savePositions() {
  try { localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions)); } catch {}
}
const positions = loadPositions();

function addPosition(row, amount) {
  const id = `${rowKey(row)}|${Date.now()}`;
  positions.push({
    id,
    rowKey: rowKey(row),
    source: row.source,
    market: row.market,
    quote: row.quote ?? "",
    category: row.category,
    fixed: !!row.fixed,
    amount: Number(amount),
    aprAtOpen: Number(row.apr),
    openedAt: Date.now(),
  });
  savePositions();
  renderPositions();
}
function removePosition(id) {
  const idx = positions.findIndex(p => p.id === id);
  if (idx >= 0) {
    positions.splice(idx, 1);
    savePositions();
    renderPositions();
  }
}

// Current APR for a position — looked up from live data by rowKey. Falls back
// to the at-open APR if the matching row isn't in the current snapshot
// (e.g. a Pendle PT that's no longer on the leaderboard).
function currentAprForPosition(p) {
  const live = state.rows.find(r => rowKey(r) === p.rowKey);
  return live ? live.apr : null;
}

function projectedEarned(p) {
  const now = Date.now();
  const days = Math.max(0, (now - p.openedAt) / (1000 * 60 * 60 * 24));
  return p.amount * (p.aprAtOpen / 100) * (days / 365);
}

function renderPositions() {
  const section = document.getElementById("positions");
  const list = document.getElementById("positions-list");
  const summary = document.getElementById("positions-summary");
  if (!section || !list || !summary) return;

  if (positions.length === 0) {
    section.classList.add("hidden");
    list.innerHTML = "";
    summary.textContent = "";
    return;
  }
  section.classList.remove("hidden");

  let totalInvested = 0;
  let totalEarned = 0;
  let weightedAprSum = 0;

  list.innerHTML = positions.map(p => {
    const earned = projectedEarned(p);
    const value = p.amount + earned;
    const currentApr = currentAprForPosition(p);
    const aprDelta = currentApr != null ? currentApr - p.aprAtOpen : null;
    const daysHeld = Math.max(0, (Date.now() - p.openedAt) / (1000 * 60 * 60 * 24));
    const cat = CATEGORY_LABELS[p.category] ?? { label: p.category, badge: "" };

    totalInvested += p.amount;
    totalEarned += earned;
    weightedAprSum += p.amount * p.aprAtOpen;

    let aprDeltaHtml = "";
    if (aprDelta != null) {
      if (Math.abs(aprDelta) < 0.05) {
        aprDeltaHtml = `<span class="pos-apr-flat">≈ без изменений</span>`;
      } else if (aprDelta > 0) {
        aprDeltaHtml = `<span class="pos-apr-up">▲ +${aprDelta.toFixed(2)}%</span>`;
      } else {
        aprDeltaHtml = `<span class="pos-apr-down">▼ ${aprDelta.toFixed(2)}%</span>`;
      }
    } else {
      aprDeltaHtml = `<span class="pos-apr-flat">нет live данных</span>`;
    }

    return `
      <div class="position-card">
        <div class="position-header">
          <div>
            <div class="position-title">${escapeHtml(p.source)} · <span class="position-market">${escapeHtml(p.market)}${p.quote ? "/" + escapeHtml(p.quote) : ""}</span></div>
            <div class="position-meta"><span class="badge ${cat.badge}">${cat.label}</span> · ${daysHeld.toFixed(1)} дн в позиции</div>
          </div>
          <button class="position-remove" data-remove-id="${escapeHtml(p.id)}" aria-label="Удалить позицию">✕</button>
        </div>
        <div class="position-body">
          <div class="position-row">
            <span class="lbl">Вложено</span>
            <span class="val">$${p.amount.toFixed(2)}</span>
          </div>
          <div class="position-row">
            <span class="lbl">Заработано (оценка)</span>
            <span class="val ${earned >= 0 ? "pos" : "neg"}">${earned >= 0 ? "+" : "−"}$${Math.abs(earned).toFixed(2)}</span>
          </div>
          <div class="position-row">
            <span class="lbl">Текущая стоимость</span>
            <span class="val"><b>$${value.toFixed(2)}</b></span>
          </div>
          <div class="position-row">
            <span class="lbl">APR при входе</span>
            <span class="val">${p.aprAtOpen.toFixed(2)}%${currentApr != null ? ` <span class="dim">→ ${currentApr.toFixed(2)}%</span>` : ""} ${aprDeltaHtml}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");

  const totalValue = totalInvested + totalEarned;
  const weightedApr = totalInvested > 0 ? weightedAprSum / totalInvested : 0;
  summary.innerHTML = `
    <span>Всего: <b class="text-zinc-200">$${totalValue.toFixed(2)}</b></span>
    <span class="ml-3">Заработано: <b class="${totalEarned >= 0 ? "text-emerald-400" : "text-rose-400"}">${totalEarned >= 0 ? "+" : "−"}$${Math.abs(totalEarned).toFixed(2)}</b></span>
    <span class="ml-3">Средн. APR: <b class="text-zinc-200">${weightedApr.toFixed(2)}%</b></span>
  `;

  // Wire delete buttons
  list.querySelectorAll(".position-remove").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.dataset.removeId;
      if (!id) return;
      if (confirm("Удалить эту позицию из трекера?")) removePosition(id);
    });
  });
}

// ─── Watchlist (separate storage so user can clear filters without losing stars) ─

const WATCHLIST_KEY = "soomqa.watchlist.v1";
function loadWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}
function saveWatchlist() {
  try { localStorage.setItem(WATCHLIST_KEY, JSON.stringify([...watchlist])); } catch {}
}
const watchlist = loadWatchlist();

function rowKey(r) {
  return `${r.source}|${r.market}|${r.category}`;
}
function isWatched(r) {
  return watchlist.has(rowKey(r));
}
function toggleWatched(r) {
  const key = rowKey(r);
  if (watchlist.has(key)) watchlist.delete(key);
  else watchlist.add(key);
  saveWatchlist();
}

const els = {
  rows: document.getElementById("rows"),
  search: document.getElementById("search"),
  category: document.getElementById("category-filter"),
  sort: document.getElementById("sort-by"),
  minApr: document.getElementById("min-apr"),
  maxApr: document.getElementById("max-apr"),
  liquidOnly: document.getElementById("liquid-only"),
  watchlistOnly: document.getElementById("watchlist-only"),
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
    spreadApr: document.getElementById("sum-spread-apr"),
    spreadSrc: document.getElementById("sum-spread-src"),
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
  if (state.filters.watchlistOnly) {
    out = out.filter(r => isWatched(r));
  }

  switch (sort) {
    case "apr-desc": out = [...out].sort((a, b) => b.apr - a.apr); break;
    case "apr-asc":  out = [...out].sort((a, b) => a.apr - b.apr); break;
    case "source":   out = [...out].sort((a, b) => a.source.localeCompare(b.source) || b.apr - a.apr); break;
    case "market":   out = [...out].sort((a, b) => a.market.localeCompare(b.market) || b.apr - a.apr); break;
  }
  return out;
}

// ─── Recommendation engine ────────────────────────────────────────────────────
//
// Given a row, its history stats, the user's amount, and the projection table,
// produce a "should I enter right now?" verdict with reasons. The engine is
// rule-based (no ML, no opacity) — every reason is auditable, and the rules
// differ by category so funding rates don't get judged like stable lending.

const VERDICTS = {
  go:   { label: "Стоит зайти",       emoji: "🟢", cls: "verdict-go" },
  wait: { label: "Лучше подождать",   emoji: "🟡", cls: "verdict-wait" },
  skip: { label: "Не стоит",          emoji: "🔴", cls: "verdict-skip" },
};

function makeRecommendation(row, stats, amount, breakDays) {
  const reasons = [];
  const pros = [];
  const cons = [];
  let score = 0;

  const fees = feesForCategory(row.category, amount);
  const oneMonthNet = projectAt(row, amount, 30).net;

  // ─── Universal red flags ────────────────────────────────────────────────────
  if (row.liquid === false) {
    cons.push("Тонкий рынок — APR может быстро откатиться");
    score -= 40;
  }
  if (row.apr < 0) {
    cons.push("APR отрицательный — ты будешь платить, не получать");
    score -= 80;
  }
  if (row.nonCrypto) {
    cons.push("Equity/index perp — без лёгкого хеджа на споте funding не поймать");
    score -= 50;
  }
  if (oneMonthNet < 0) {
    cons.push(`На $${amount.toFixed(0)} за месяц убыток после fees (${oneMonthNet.toFixed(2)}$)`);
    score -= 30;
  }
  if (breakDays != null && breakDays > 30) {
    cons.push(`Break-even ${formatDuration(breakDays, row)} — слишком долго для текущей суммы`);
    score -= 20;
  } else if (breakDays != null && breakDays > 0 && breakDays < 1) {
    pros.push(`Окупаемость менее суток (${formatDuration(breakDays, row)})`);
    score += 10;
  }

  // ─── Category-specific reasoning ────────────────────────────────────────────
  if (row.category === "funding-rate") {
    judgeFundingRate(row, stats, pros, cons, score => score, n => score += n);
    // Use mutator-via-closure to keep score in one place. JS doesn't have
    // by-reference primitives, so we re-thread the value below.
    score += fundingRateScore(row, stats, pros, cons);
  } else if (row.category === "stable-lending") {
    score += stableLendingScore(row, stats, pros, cons);
  } else if (row.category === "fixed-yield") {
    score += fixedYieldScore(row, stats, pros, cons, amount);
  } else if (row.category === "delta-neutral") {
    score += deltaNeutralScore(row, stats, pros, cons);
  } else if (row.category === "restaking") {
    score += restakingScore(row, stats, pros, cons);
  } else if (row.category === "cross-exchange-spread") {
    score += spreadScore(row, pros, cons);
  }

  // ─── Compare against safest baseline ────────────────────────────────────────
  const baseline = findBaselineComparison(row);
  if (baseline) {
    const baseNet = projectAt(baseline, amount, 30).net;
    const diff = oneMonthNet - baseNet;
    if (diff > Math.abs(baseNet) * 0.5 && diff > 1) {
      pros.push(`За месяц приносит на $${diff.toFixed(2)} больше чем безопасный ${baseline.source} (${baseline.apr.toFixed(2)}%)`);
      score += 10;
    } else if (diff < -1 && row.category !== "stable-lending") {
      cons.push(`Безопасный ${baseline.source} приносит больше на $${Math.abs(diff).toFixed(2)}/мес`);
      score -= 15;
    }
  }

  // ─── Final verdict ──────────────────────────────────────────────────────────
  let verdict;
  if (score >= 30)       verdict = "go";
  else if (score >= -10) verdict = "wait";
  else                   verdict = "skip";

  // Override: anything with critical cons goes straight to skip
  if (oneMonthNet < 0 || row.apr < 0 || row.nonCrypto) verdict = "skip";

  return { verdict, score, pros, cons };
}

// Funding-rate specific score adjustments. Mutates pros/cons.
function fundingRateScore(row, stats, pros, cons) {
  let delta = 0;
  if (!stats) {
    cons.push("Истории недостаточно — нельзя оценить устойчивость ставки");
    return -5;
  }
  const ratio = stats.avg !== 0 ? row.apr / stats.avg : 1;
  const range = stats.max - stats.min;
  const cv = stats.avg !== 0 ? range / Math.abs(stats.avg) : 0;  // coefficient-of-variation proxy

  if (Math.abs(ratio) > 2 && row.apr > 0) {
    cons.push(`Текущая APR в ${ratio.toFixed(1)}× выше среднего — спайк, мгновенно может откатиться к ${stats.avg.toFixed(1)}%`);
    delta -= 20;
  } else if (Math.abs(ratio) > 1.5 && row.apr > 0) {
    cons.push(`Ставка выше среднего в ${ratio.toFixed(1)}× — может откатиться`);
    delta -= 10;
  } else if (Math.abs(ratio) > 0.8 && Math.abs(ratio) < 1.3 && stats.avg > 10) {
    pros.push(`Ставка близка к среднему (${stats.avg.toFixed(1)}%) — sustainable значение`);
    delta += 15;
  } else if (stats.avg < 0 || (stats.avg < 5 && row.apr < 10)) {
    cons.push(`Средняя ставка за период всего ${stats.avg.toFixed(1)}% — низкий yield`);
    delta -= 15;
  }

  if (cv > 5 && stats.count > 5) {
    cons.push(`Высокая волатильность ставки (разброс ${stats.min.toFixed(1)}…${stats.max.toFixed(1)}%) — непредсказуемо`);
    delta -= 10;
  } else if (cv < 1 && stats.count > 5 && stats.avg > 8) {
    pros.push("Низкая волатильность — ставка ведёт себя стабильно");
    delta += 10;
  }

  if (stats.min < -5) {
    cons.push(`Ставка уходила в минус (${stats.min.toFixed(1)}%) — может повториться`);
    delta -= 5;
  }

  return delta;
}

function stableLendingScore(row, stats, pros, cons) {
  let delta = 0;
  if (row.apr >= 6) { pros.push(`Хорошая ставка для стейбла (${row.apr.toFixed(2)}%)`); delta += 15; }
  else if (row.apr >= 4) { pros.push(`Средняя по рынку ставка для стейбла`); delta += 5; }
  else { cons.push(`Низкая ставка для стейбла (${row.apr.toFixed(2)}%) — у других выше`); delta -= 10; }

  if (row.tvl && row.tvl > 500_000_000) { pros.push(`TVL ${formatUsdShort(row.tvl)} — глубокая ликвидность, мгновенный вывод`); delta += 10; }
  else if (row.tvl && row.tvl < 50_000_000) { cons.push(`TVL ${formatUsdShort(row.tvl)} — низкая глубина`); delta -= 10; }

  if (stats) {
    if (row.apr > stats.avg * 1.3) { pros.push(`Сейчас выше исторического (среднее ${stats.avg.toFixed(2)}%) — момент удачный`); delta += 10; }
    else if (row.apr < stats.avg * 0.7) { cons.push(`Ниже исторического — лучше подождать`); delta -= 5; }
  }

  return delta;
}

function fixedYieldScore(row, stats, pros, cons, amount) {
  let delta = 10;  // baseline: fixed yields are inherently safer than variable
  // Compare to top stable lending — fixed should be at least 3% premium over
  // floating rate to justify lock-up.
  const stableBaseline = state.rows
    .filter(r => r.liquid && r.category === "stable-lending")
    .reduce((a, b) => !a || b.apr > a.apr ? b : a, null);
  if (stableBaseline) {
    const premium = row.apr - stableBaseline.apr;
    if (premium >= 5) { pros.push(`Премия ${premium.toFixed(1)}% над лендингом ${stableBaseline.source} — лочить выгодно`); delta += 15; }
    else if (premium >= 2) { pros.push(`Небольшая премия (${premium.toFixed(1)}%) над лендингом`); delta += 5; }
    else if (premium < 0) { cons.push(`APR ниже лендинга ${stableBaseline.source} — нет смысла лочить`); delta -= 30; }
    else { cons.push(`Премия над лендингом мала (${premium.toFixed(1)}%) — не оправдывает локап`); delta -= 5; }
  }
  if (row.tvl && row.tvl < 10_000_000) {
    cons.push(`TVL ${formatUsdShort(row.tvl)} — низкая ликвидность PT, exit до maturity может быть дорогим`);
    delta -= 10;
  } else if (row.tvl && row.tvl > 100_000_000) {
    pros.push(`TVL ${formatUsdShort(row.tvl)} — глубокий рынок PT`);
    delta += 5;
  }
  return delta;
}

function deltaNeutralScore(row, stats, pros, cons) {
  let delta = 0;
  if (row.apr >= 12) { pros.push(`Хорошая ставка для упакованного funding arb (${row.apr.toFixed(2)}%)`); delta += 15; }
  else if (row.apr >= 6) { pros.push(`Приемлемая ставка для дельта-нейтрала`); delta += 5; }
  else { cons.push(`Низкая ставка (${row.apr.toFixed(2)}%) — funding-rates на рынке сжаты`); delta -= 15; }

  if (stats && row.apr < stats.avg * 0.6) {
    cons.push(`Сейчас ниже исторического — funding на рынке остывает`);
    delta -= 10;
  }
  return delta;
}

function spreadScore(row, pros, cons) {
  let delta = 0;
  if (row.apr >= 20) {
    pros.push(`Хороший спред ${row.apr.toFixed(1)}% APR — окупит fees двух бирж быстро`);
    delta += 20;
  } else if (row.apr >= 10) {
    pros.push(`Умеренный спред ${row.apr.toFixed(1)}% — окупится за неделю-две`);
    delta += 5;
  } else {
    cons.push(`Маленький спред (${row.apr.toFixed(1)}%) — fees 0.4% съедят большую часть`);
    delta -= 10;
  }
  if (row.longLeg && row.shortLeg) {
    if (row.longLeg.apr < 0) {
      pros.push(`На long-ноге (${row.longLeg.source}) ты получаешь funding ${row.longLeg.apr.toFixed(2)}% — двойной плюс`);
      delta += 10;
    }
    if (row.shortLeg.apr < 10) {
      cons.push(`Short-нога низкая — funding-rate может откатиться, спред сожмётся`);
      delta -= 5;
    }
  }
  // Cross-exchange = double capital lock-up (need margin on both venues).
  // Worth flagging so the user remembers it.
  cons.push(`Нужен капитал на 2 биржах одновременно (один комитит обе ноги)`);
  return delta;
}

function restakingScore(row, stats, pros, cons) {
  let delta = 0;
  if (row.apr >= 4) { pros.push(`Доходность ETH-уровня (${row.apr.toFixed(2)}%) + airdrop-points бонусом`); delta += 10; }
  else { cons.push(`Низкая доходность даже для рестейкинга`); delta -= 10; }
  return delta;
}

// Stub kept for parallel structure — real logic lives in *Score helpers above.
function judgeFundingRate() {}

function renderRecommendation(row, stats, amount, breakDays) {
  if (amount <= 0) return "";
  const rec = makeRecommendation(row, stats, amount, breakDays);
  const v = VERDICTS[rec.verdict];

  const prosHtml = rec.pros.length > 0
    ? `<ul class="rec-list rec-pros">${rec.pros.map(p => `<li>✓ ${escapeHtml(p)}</li>`).join("")}</ul>`
    : "";
  const consHtml = rec.cons.length > 0
    ? `<ul class="rec-list rec-cons">${rec.cons.map(c => `<li>✗ ${escapeHtml(c)}</li>`).join("")}</ul>`
    : "";

  return `
    <div class="recommendation ${v.cls}">
      <div class="rec-headline">${v.emoji} <b>${v.label}</b> <span class="rec-score">${rec.score >= 0 ? "+" : ""}${rec.score}</span></div>
      ${prosHtml}
      ${consHtml}
      ${renderExecutionGuide(row, amount)}
    </div>
  `;
}

// Step-by-step "how to actually open this position" guide per category.
// Surfaces the practical translation between "what the table says" and
// "what you click in real life". Specific to the category, parameterised
// by amount and (for spreads) leg sources/symbols.
function renderExecutionGuide(row, amount) {
  const steps = guideStepsFor(row, amount);
  if (!steps || steps.length === 0) return "";
  const html = steps.map((s, i) => `<li>${s}</li>`).join("");
  return `
    <details class="exec-guide">
      <summary>📋 Как открыть позицию — шаги</summary>
      <ol class="exec-steps">${html}</ol>
    </details>
  `;
}

function guideStepsFor(row, amount) {
  const amt = Math.max(50, Math.round(amount));
  if (row.category === "stable-lending") {
    return [
      `Купи USDC/USDT/USDe на $${amt} на любой бирже (Bybit, OKX, BingX).`,
      `Withdraw на свой Web3-кошелёк (MetaMask, Rabby) — сеть Ethereum / Base / Arbitrum по адресу контракта пула.`,
      `Зайди на <strong>${escapeHtml(row.source)}</strong> (например app.aave.com / app.morpho.org).`,
      `Connect Wallet → выбери нужный chain.`,
      `Supply $${amt} в пул <strong>${escapeHtml(row.market)}</strong> → проценты начисляются автоматически.`,
      `💡 Снимать можно когда угодно. Газ на L2 (Base/Arbitrum) ~$0.10-2, на mainnet — $5-20.`,
    ];
  }
  if (row.category === "fixed-yield") {
    return [
      `Купи USDC/USDT/ETH на $${amt} на бирже.`,
      `Withdraw в свой Web3-кошелёк.`,
      `Зайди на <strong>app.pendle.finance</strong> (или Boros если строка от Pendle Boros).`,
      `Markets → найди этот PT (<strong>${escapeHtml(row.market)}</strong>) → нажми "Buy PT".`,
      `Покупка фиксирует доходность <b>${row.apr.toFixed(2)}%</b> до даты maturity.`,
      `💡 До maturity early exit возможен но с slippage. Лучше держать до даты — тогда нет fees на выход.`,
    ];
  }
  if (row.category === "delta-neutral") {
    return [
      `Купи USDT/USDC на $${amt} на бирже.`,
      `Withdraw в Web3-кошелёк.`,
      `Зайди на <strong>app.ethena.fi</strong>.`,
      `Mint USDe → переключи на sUSDe (stake) для получения yield.`,
      `💡 sUSDe растёт стоимостью (не rebase). Через 7 дней cooldown на anstake → USDe → withdraw на биржу.`,
    ];
  }
  if (row.category === "restaking") {
    return [
      `Купи ETH на $${amt} на бирже.`,
      `Withdraw в свой Web3-кошелёк.`,
      `Зайди на сайт LRT (ether.fi / renzo / kelp / puffer) указанный в Source.`,
      `Stake ETH → получаешь LRT token (eETH / ezETH / rsETH / pufETH).`,
      `💡 Holding токена = автоматически yield + airdrop points. Можно использовать как collateral на Aave для leverage.`,
    ];
  }
  if (row.category === "funding-rate") {
    const halfAmt = Math.round(amt / 2);
    return [
      `Купи спот <strong>${escapeHtml(row.market)}</strong> на <strong>${escapeHtml(row.source)}</strong> на $${halfAmt}.`,
      `На той же бирже открой <b>SHORT perpetual</b> на $${halfAmt} (тот же символ).`,
      `Каждый funding cycle (8h на Bybit/MEXC/Gate/HTX, 1h на HL) получаешь funding rate × position size.`,
      `Если хочешь leverage — открыть с margin (например 2× = $${Math.round(halfAmt / 2)} margin → $${halfAmt} position). Внимание: liquidation risk.`,
      `💡 Это delta-neutral — price не влияет. Закрывай обе ноги одновременно когда funding падает.`,
    ];
  }
  if (row.category === "cross-exchange-spread" && row.longLeg && row.shortLeg) {
    const half = Math.round(amt / 2);
    return [
      `Раздели $${amt} пополам — по $${half} на две биржи.`,
      `На <strong>${escapeHtml(row.longLeg.source)}</strong> купи спот <strong>${escapeHtml(row.longLeg.market)}</strong> на $${half}.`,
      `На <strong>${escapeHtml(row.shortLeg.source)}</strong> открой <b>SHORT perpetual</b> <strong>${escapeHtml(row.shortLeg.market)}</strong> на $${half}.`,
      `Каждые 8h: long-биржа выплачивает (или забирает) ${row.longLeg.apr.toFixed(2)}% APR funding, short-биржа выплачивает ${row.shortLeg.apr.toFixed(2)}% APR.`,
      `Чистый spread тебе: <b>+${row.apr.toFixed(2)}% APR</b> delta-neutral.`,
      `💡 Закрывай обе ноги одновременно когда spread схлопывается (≤5% APR). Не оставляй одну ногу открытой — это directional risk.`,
    ];
  }
  return null;
}

// ─── Historical APR / yield (loaded on demand when a row is expanded) ────────
//
// Each source has its own history endpoint and returns its own time series
// shape. We normalise everything into { points: [{ time, value }], unit: "%" }
// where `value` is already in APR percent.
//
// Cache: in-memory only. Cleared on page reload. 5-minute freshness so we
// don't re-fetch on every keystroke in the calculator.

const HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
const historyCache = new Map();  // key = `${rowKey}|${period}` → { points, fetchedAt }

function historyCacheKey(row, periodDays) {
  return `${rowKey(row)}|${periodDays}`;
}

async function loadHistoryFor(row, periodDays) {
  const key = historyCacheKey(row, periodDays);
  const cached = historyCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL_MS) {
    return { ok: true, data: cached };
  }
  try {
    let points;
    if (row.source === "Binance")          points = await fetchBinanceHistory(row, periodDays);
    else if (row.source === "Bybit")       points = await fetchBybitHistory(row, periodDays);
    else if (row.source === "Hyperliquid") points = await fetchHyperliquidHistory(row, periodDays);
    else if (row.poolId)                   points = await fetchDefiLlamaHistory(row, periodDays);
    else return { ok: false, error: "источник без истории" };

    const entry = { points, fetchedAt: Date.now() };
    historyCache.set(key, entry);
    return { ok: true, data: entry };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function fetchBinanceHistory(row, periodDays) {
  // 3 funding cycles per day (8h each) — request enough points to fill the window.
  const limit = Math.min(1000, Math.max(20, Math.ceil(periodDays * 3)));
  const symbol = `${row.market}${row.quote}`;
  const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
  const data = await getJson(url);
  return data.map(d => ({
    time: Number(d.fundingTime),
    value: Number(d.fundingRate) * APR_8H * 100,
  }));
}

async function fetchBybitHistory(row, periodDays) {
  const limit = Math.min(200, Math.max(20, Math.ceil(periodDays * 3)));
  const symbol = row.quote === "USDC" ? `${row.market}PERP` : `${row.market}USDT`;
  const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
  const data = await getJson(url);
  const list = data?.result?.list ?? [];
  // Bybit returns newest-first; reverse so x-axis flows left→right in time.
  return list.slice().reverse().map(d => ({
    time: Number(d.fundingRateTimestamp),
    value: Number(d.fundingRate) * APR_8H * 100,
  }));
}

async function fetchHyperliquidHistory(row, periodDays) {
  const startTime = Date.now() - periodDays * 24 * 60 * 60 * 1000;
  const data = await postJson("https://api.hyperliquid.xyz/info", {
    type: "fundingHistory",
    coin: row.market,
    startTime,
  });
  return (data ?? []).map(d => ({
    time: Number(d.time),
    value: Number(d.fundingRate) * APR_1H * 100,
  }));
}

async function fetchDefiLlamaHistory(row, periodDays) {
  const url = `https://yields.llama.fi/chart/${encodeURIComponent(row.poolId)}`;
  const data = await getJson(url);
  if (data.status !== "success") throw new Error(`bad status: ${data.status}`);
  const cutoff = Date.now() - periodDays * 24 * 60 * 60 * 1000;
  return data.data
    .map(d => ({
      time: new Date(d.timestamp).getTime(),
      value: Number(d.apy) || 0,
    }))
    .filter(p => p.time >= cutoff);
}

// ─── Sparkline (pure SVG, no library) ─────────────────────────────────────────
//
// Renders an APR sparkline + invisible hover/touch overlay that surfaces a
// tooltip with the exact date and value at the user's finger position.
// On mobile this picks up touchmove naturally; on desktop, mousemove.

const SPARK_W = 320;
const SPARK_H = 140;  // doubled from 70 so trends are readable on mobile

function renderSparkline(points) {
  if (!points || points.length < 2) {
    return `<div class="sparkline-wrap"><svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" class="sparkline"><text x="${SPARK_W/2}" y="${SPARK_H/2}" text-anchor="middle" fill="#6b7280" font-size="11">Недостаточно данных</text></svg></div>`;
  }
  const values = points.map(p => p.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = (maxV - minV) || 1;
  const stepX = (SPARK_W - 4) / (points.length - 1);
  const yFor = v => SPARK_H - 4 - ((v - minV) / range) * (SPARK_H - 8);
  const xFor = i => 2 + i * stepX;

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(2)} ${yFor(p.value).toFixed(2)}`).join(" ");
  const fillPath = `${path} L ${(SPARK_W - 2).toFixed(2)} ${SPARK_H - 2} L 2 ${SPARK_H - 2} Z`;

  const zeroVisible = minV < 0 && maxV > 0;
  const zeroY = zeroVisible ? yFor(0) : null;

  const lastIdx = points.length - 1;
  const lastX = xFor(lastIdx);
  const lastY = yFor(points[lastIdx].value);
  const lastClass = points[lastIdx].value < 0 ? "spark-neg" : "spark-pos";

  return `
    <div class="sparkline-wrap">
      <svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" class="sparkline">
        ${zeroVisible ? `<line x1="0" x2="${SPARK_W}" y1="${zeroY}" y2="${zeroY}" class="spark-zero"/>` : ""}
        <path d="${fillPath}" class="spark-fill"/>
        <path d="${path}" class="spark-line"/>
        <circle cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="4" class="${lastClass}"/>
        <line x1="0" x2="0" y1="0" y2="${SPARK_H}" class="spark-hover-line" style="display:none"/>
        <circle r="6" class="spark-hover-marker" style="display:none"/>
        <!-- Transparent overlay catches pointer events across the whole canvas.
             Without this, iOS Safari only fires events when the finger lands
             on the actual line/path pixel, which is unusable on a 1.8px line. -->
        <rect x="0" y="0" width="${SPARK_W}" height="${SPARK_H}" class="spark-hover-area"/>
      </svg>
      <div class="sparkline-tooltip" style="display:none"></div>
    </div>
  `;
}

// Attach mouse/touch interactivity to a sparkline wrapper. Called after the
// section is mounted (or replaced) in the DOM. `points` is the same array
// that was used to render the SVG.
function attachSparklineHover(wrap, points) {
  if (!wrap || !points || points.length < 2) return;
  const svg = wrap.querySelector("svg.sparkline");
  const tooltip = wrap.querySelector(".sparkline-tooltip");
  const hoverLine = wrap.querySelector(".spark-hover-line");
  const hoverMarker = wrap.querySelector(".spark-hover-marker");
  if (!svg || !tooltip || !hoverLine || !hoverMarker) return;

  const values = points.map(p => p.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = (maxV - minV) || 1;

  function handleAt(clientX) {
    const rect = svg.getBoundingClientRect();
    const relX = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const ratio = relX / rect.width;
    // Convert ratio → index in the points array.
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
    const p = points[idx];

    // Convert idx → SVG coordinate, then to screen pixels via the SVG's
    // viewBox/element ratio. Easier: use percentages on the line element.
    const xSvg = 2 + (idx * (SPARK_W - 4) / (points.length - 1));
    const ySvg = SPARK_H - 4 - ((p.value - minV) / range) * (SPARK_H - 8);

    hoverLine.style.display = "";
    hoverLine.setAttribute("x1", String(xSvg));
    hoverLine.setAttribute("x2", String(xSvg));

    hoverMarker.style.display = "";
    hoverMarker.setAttribute("cx", String(xSvg));
    hoverMarker.setAttribute("cy", String(ySvg));

    tooltip.style.display = "";
    tooltip.innerHTML = formatTooltip(p);
    // Position tooltip in CSS pixels relative to wrapper.
    const pxLeft = (xSvg / SPARK_W) * rect.width;
    tooltip.style.left = `${Math.max(0, Math.min(rect.width - tooltip.offsetWidth, pxLeft - tooltip.offsetWidth / 2))}px`;
  }

  function clear() {
    hoverLine.style.display = "none";
    hoverMarker.style.display = "none";
    tooltip.style.display = "none";
  }

  // Pointer events unify mouse and touch on modern browsers (including iOS
  // Safari ≥13). pointerdown captures the pointer so subsequent moves keep
  // firing on the SVG even if the finger drifts a few pixels off.
  let tracking = false;
  function onDown(e) {
    tracking = true;
    handleAt(e.clientX);
    try { svg.setPointerCapture(e.pointerId); } catch {}
  }
  function onMove(e) {
    if (e.pointerType === "mouse" || tracking) handleAt(e.clientX);
  }
  function onUp(e) {
    tracking = false;
    try { svg.releasePointerCapture(e.pointerId); } catch {}
    // Keep tooltip visible briefly after release on touch so the user can
    // read the value. On mouse, leave handler clears it immediately.
    if (e.pointerType !== "mouse") setTimeout(clear, 1500);
  }
  svg.addEventListener("pointerdown", onDown);
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerup", onUp);
  svg.addEventListener("pointercancel", onUp);
  svg.addEventListener("pointerleave", e => {
    if (e.pointerType === "mouse") clear();
  });
}

function formatTooltip(point) {
  const date = new Date(point.time);
  const now = Date.now();
  const ageMs = now - point.time;
  const ageHours = ageMs / (1000 * 60 * 60);
  // Show full date for ranges > 24h, time-of-day for shorter horizons.
  let dateStr;
  if (ageHours > 36) {
    dateStr = date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  } else {
    dateStr = date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  const colour = point.value < 0 ? "color:#fca5a5" : point.value >= 15 ? "color:#4ade80" : "color:#d4d4d8";
  return `<span class="tt-date">${dateStr}</span><span class="tt-value" style="${colour}"><b>${point.value.toFixed(2)}%</b></span>`;
}

// ─── Period selector ──────────────────────────────────────────────────────────

const HISTORY_PERIODS = [
  { days: 1,  label: "24ч" },
  { days: 7,  label: "7д"  },
  { days: 30, label: "30д" },
  { days: 90, label: "90д" },
];

// Per-row selected period; persists across re-renders.
const selectedPeriods = new Map();
function selectedPeriodFor(row) {
  const key = rowKey(row);
  return selectedPeriods.get(key) ?? 7;
}

function statsFromPoints(points) {
  if (!points || points.length === 0) return null;
  const values = points.map(p => p.value);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { avg, min, max, count: values.length };
}

function renderHistorySection(row) {
  const period = selectedPeriodFor(row);
  const cacheKey = historyCacheKey(row, period);
  const cached = historyCache.get(cacheKey);

  const chips = HISTORY_PERIODS.map(p => `
    <button class="history-chip ${p.days === period ? "history-chip-active" : ""}" data-period="${p.days}">${p.label}</button>
  `).join("");

  let body;
  if (cached) {
    const stats = statsFromPoints(cached.points);
    const sparkline = renderSparkline(cached.points);
    body = `
      <div class="history-chart">${sparkline}</div>
      ${stats ? `
        <div class="history-stats">
          <span><span class="lbl">сейчас</span> <b>${row.apr.toFixed(2)}%</b></span>
          <span><span class="lbl">средн.</span> ${stats.avg.toFixed(2)}%</span>
          <span><span class="lbl">мин</span> ${stats.min.toFixed(2)}%</span>
          <span><span class="lbl">макс</span> ${stats.max.toFixed(2)}%</span>
          <span><span class="lbl">точек</span> ${stats.count}</span>
        </div>
        ${historicalVerdict(row, stats)}
      ` : `<div class="history-empty">Истории нет</div>`}
    `;
  } else {
    body = `<div class="history-loading">Загружаем историю…</div>`;
  }

  return `
    <div class="history-section" data-history-for="${row._idx}">
      <div class="history-header">
        <span class="history-title">История APR</span>
        <div class="history-chips">${chips}</div>
      </div>
      ${body}
    </div>
  `;
}

// Compare current APR against historical average → "spike", "normal", "low".
function historicalVerdict(row, stats) {
  if (stats.count < 5) return "";
  const ratio = stats.avg !== 0 ? row.apr / stats.avg : 1;
  const absDiff = row.apr - stats.avg;

  if (Math.abs(absDiff) < Math.abs(stats.avg) * 0.15) {
    return `<div class="history-verdict history-verdict-neutral">📊 Текущая ставка близка к среднему за период — стабильное значение.</div>`;
  }
  if (row.apr > stats.avg && ratio > 1.5) {
    return `<div class="history-verdict history-verdict-spike">📈 Текущая ставка в ${ratio.toFixed(1)}× выше среднего — это спайк, может откатиться.</div>`;
  }
  if (row.apr < stats.avg && ratio < 0.7) {
    return `<div class="history-verdict history-verdict-low">📉 Текущая ставка ниже среднего — ниша остыла, ждать смысла нет.</div>`;
  }
  if (row.apr > stats.avg) {
    return `<div class="history-verdict history-verdict-up">📈 Текущая ставка выше среднего на ${absDiff.toFixed(2)}%.</div>`;
  }
  return `<div class="history-verdict history-verdict-down">📉 Текущая ставка ниже среднего на ${Math.abs(absDiff).toFixed(2)}%.</div>`;
}

// Triggered after a calculator panel is mounted in the DOM. Kicks off the
// history fetch in background, then swaps the placeholder when data arrives.
async function ensureHistoryLoaded(row) {
  const period = selectedPeriodFor(row);
  const cacheKey = historyCacheKey(row, period);
  if (historyCache.has(cacheKey)) {
    repaintHistorySection(row);
    return;
  }
  const result = await loadHistoryFor(row, period);
  if (!result.ok) {
    // Stash an empty placeholder so we don't refetch a failing endpoint in
    // a tight loop; but DO let the user retry after the TTL.
    historyCache.set(cacheKey, { points: [], fetchedAt: Date.now() });
  }
  repaintHistorySection(row);
}

function repaintHistorySection(row) {
  if (!row || row._idx == null) return;
  const section = document.querySelector(`.history-section[data-history-for="${row._idx}"]`);
  if (!section) return;
  const newHtml = renderHistorySection(row);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = newHtml;
  const newSection = wrapper.firstElementChild;
  section.replaceWith(newSection);
  wireHistoryChipListeners(newSection, row);
  // Attach hover/touch tooltip to the just-rendered sparkline.
  const period = selectedPeriodFor(row);
  const cached = historyCache.get(historyCacheKey(row, period));
  if (cached && cached.points.length >= 2) {
    const sparkWrap = newSection.querySelector(".sparkline-wrap");
    attachSparklineHover(sparkWrap, cached.points);
  }
  // Recommendation depends on history stats — re-paint it whenever the
  // history section changes (new data arrived, or user switched period).
  repaintRecommendation(row);
}

function wireHistoryChipListeners(section, row) {
  section.querySelectorAll(".history-chip").forEach(chip => {
    chip.addEventListener("click", e => {
      e.stopPropagation();
      const days = Number(chip.dataset.period);
      selectedPeriods.set(rowKey(row), days);
      repaintHistorySection(row);
      ensureHistoryLoaded(row);
    });
  });
}


//
// Click a row → a panel drops underneath. The user enters ONLY the amount.
// The calculator then projects the position across all relevant horizons,
// computes break-even (when entry/exit fees pay off), and recommends the
// horizon that maximises net APY after fees.
//
// Honesty principle: a "39% APR" funding rate is misleading for short holds.
// $500 × 39% APR × 1 cycle = $0.18 gross; $1.00 round-trip fees = $0.82 LOSS.
// The horizon table makes this obvious instead of hiding it behind one number.

function feesForCategory(category, amount) {
  switch (category) {
    case "funding-rate":   return amount * 0.002;   // 4 taker trades × 0.05%
    case "delta-neutral":  return amount * 0.001;   // Ethena mint/redeem
    case "fixed-yield":    return amount * 0.001;   // Pendle PT entry/exit
    case "stable-lending": return 0;                // gas only; ≈ 0
    case "restaking":      return 0;
    case "cross-exchange-spread":
      // 4 taker trades across 2 exchanges (open long, open short, close
      // long, close short) ≈ 0.40% round-trip. Slightly higher than a
      // single-venue funding play because both legs pay independently.
      return amount * 0.004;
    default:               return 0;
  }
}

// Horizons we project for each category. The "cycle" for funding rates is a
// real-world artefact (8h on Binance/Bybit, 1h on Hyperliquid) so we surface
// it explicitly — it's the shortest unit at which funding can be captured.
function horizonsFor(row) {
  if (row.category === "funding-rate") {
    const cycleHours = row.source === "Hyperliquid" ? 1 : 8;
    const cycleDays = cycleHours / 24;
    return [
      { label: `1 цикл (${cycleHours}ч)`, days: cycleDays },
      { label: "1 день",   days: 1 },
      { label: "1 неделя", days: 7 },
      { label: "1 месяц",  days: 30 },
      { label: "1 год",    days: 365 },
    ];
  }
  if (row.category === "fixed-yield") {
    return [
      { label: "1 неделя", days: 7 },
      { label: "1 месяц",  days: 30 },
      { label: "3 месяца", days: 90 },
      { label: "До maturity (≈6 мес)", days: 180 },
      { label: "1 год",    days: 365 },
    ];
  }
  if (row.category === "cross-exchange-spread") {
    // Delta-neutral spreads are usually held days-to-weeks until funding
    // converges. Show a wide horizon spread to make break-even visible.
    return [
      { label: "1 день",   days: 1 },
      { label: "3 дня",    days: 3 },
      { label: "1 неделя", days: 7 },
      { label: "1 месяц",  days: 30 },
      { label: "1 год",    days: 365 },
    ];
  }
  // Stable lending, restaking, delta-neutral — same set, days-based.
  return [
    { label: "1 день",   days: 1 },
    { label: "1 неделя", days: 7 },
    { label: "1 месяц",  days: 30 },
    { label: "3 месяца", days: 90 },
    { label: "1 год",    days: 365 },
  ];
}

// Returns: { gross, net, netApy, isProfit }
function projectAt(row, amount, days) {
  const apr = row.apr / 100;
  const gross = amount * apr * (days / 365);
  const fees = feesForCategory(row.category, amount);
  const net = gross - fees;
  // Annualised return on capital, net of fees, at this horizon.
  const netApy = days > 0 && amount > 0 ? (net / amount) * (365 / days) * 100 : 0;
  return { gross, fees, net, netApy, isProfit: net > 0.01 };
}

// How long until accumulated yield covers the entry/exit fees? In days.
// Returns null if APR is non-positive or there are no fees (instantly free).
function breakEvenDays(row, amount) {
  const fees = feesForCategory(row.category, amount);
  if (fees <= 0) return 0;
  const apr = row.apr / 100;
  if (apr <= 0 || amount <= 0) return null;
  const yieldPerDay = amount * apr / 365;
  return fees / yieldPerDay;
}

// Translate days to a human label that respects the row's natural cadence.
function formatDuration(days, row) {
  if (days == null) return "—";
  if (row.category === "funding-rate") {
    const cycleHours = row.source === "Hyperliquid" ? 1 : 8;
    const cycles = (days * 24) / cycleHours;
    if (cycles < 1)  return `<1 цикла (${(cycles * cycleHours).toFixed(1)}ч)`;
    if (cycles < 24) return `${cycles.toFixed(1)} циклов (${(cycles * cycleHours / 24).toFixed(1)}д)`;
  }
  if (days < 1)   return `${(days * 24).toFixed(1)}ч`;
  if (days < 7)   return `${days.toFixed(1)} д`;
  if (days < 30)  return `${(days / 7).toFixed(1)} нед`;
  if (days < 365) return `${(days / 30).toFixed(1)} мес`;
  return `${(days / 365).toFixed(1)} лет`;
}

function renderCalculator(row) {
  const state = ensureCalcState(row);
  const amount = Math.max(0, Number(state.amount) || 0);
  const fees = feesForCategory(row.category, amount);
  const horizons = horizonsFor(row);
  const projections = horizons.map(h => ({ ...h, ...projectAt(row, amount, h.days) }));
  const breakDays = breakEvenDays(row, amount);

  // Best horizon = highest net APY *among profitable ones*. If none profitable,
  // recommend skipping (or holding for break-even).
  let bestIdx = -1;
  for (let i = 0; i < projections.length; i++) {
    if (!projections[i].isProfit) continue;
    if (bestIdx === -1 || projections[i].netApy > projections[bestIdx].netApy) bestIdx = i;
  }

  const variableNote = (row.category === "funding-rate" || row.category === "delta-neutral")
    ? `<span class="calc-warning">⚠ APR переменная — расчёт предполагает, что ставка не изменится</span>`
    : (row.category === "stable-lending"
      ? `<span class="calc-warning">⚠ APY меняется, но обычно в пределах ±2%</span>`
      : `<span class="calc-warning">✓ Доходность зафиксирована до даты maturity</span>`);

  const rows = projections.map((p, i) => {
    const netClass = p.isProfit ? "pos" : "neg";
    const netSign = p.net >= 0 ? "" : "−";
    const apyClass = p.isProfit ? "pos" : "neg";
    const star = i === bestIdx ? '<span class="calc-star" title="Лучший горизонт по net APY">★</span>' : "";
    return `
      <tr class="${i === bestIdx ? "calc-best" : ""}">
        <td>${star}${p.label}</td>
        <td class="num">$${p.gross.toFixed(2)}</td>
        <td class="num neg">−$${p.fees.toFixed(2)}</td>
        <td class="num ${netClass}">${netSign}$${Math.abs(p.net).toFixed(2)}</td>
        <td class="num ${apyClass}">${p.netApy >= 0 ? "" : "−"}${Math.abs(p.netApy).toFixed(1)}%</td>
      </tr>
    `;
  }).join("");

  const breakLine = (breakDays == null)
    ? `<div class="calc-recommendation">Окупаемость не достижима при текущем APR.</div>`
    : breakDays === 0
      ? `<div class="calc-recommendation">⚡ Fees нет — доходность чистая с первого дня.</div>`
      : `<div class="calc-recommendation">⚡ Break-even: <b>${formatDuration(breakDays, row)}</b> (когда заработок покрывает fees ${fees.toFixed(2)}$)</div>`;

  const verdict = bestIdx >= 0
    ? `<div class="calc-recommendation">🎯 Оптимально: <b>${escapeHtml(projections[bestIdx].label)}</b> — net APY <b>${projections[bestIdx].netApy.toFixed(1)}%</b></div>`
    : `<div class="calc-recommendation neg">🚫 На сумме $${amount.toFixed(0)} ни один горизонт не окупается. Нужна сумма больше или APR выше.</div>`;

  // Opportunity cost — what would the same capital earn in the safest liquid
  // alternative right now (top stable lending APR among liquid rows)?
  const baseline = findBaselineComparison(row);
  const baselineBlock = baseline
    ? renderBaselineComparison(row, baseline, amount, projections[bestIdx >= 0 ? bestIdx : projections.length - 1])
    : "";

  // For cross-exchange spreads, surface the two legs explicitly — the user
  // needs to know WHERE to long and WHERE to short. The "note" column shows
  // the same info but it's hidden on mobile breakpoints.
  const hedgeBlock = row.category === "cross-exchange-spread" && row.longLeg && row.shortLeg
    ? `
      <div class="calc-hedge">
        <div class="calc-hedge-title">🔀 Как открывать хедж</div>
        <div class="calc-hedge-row calc-hedge-long">
          <span class="calc-hedge-side">📈 LONG</span>
          <div class="calc-hedge-detail">
            <div class="calc-hedge-venue">${escapeHtml(row.longLeg.source)}</div>
            <div class="calc-hedge-market">${escapeHtml(row.longLeg.market)}${row.longLeg.quote ? "/" + escapeHtml(row.longLeg.quote) : ""}</div>
          </div>
          <span class="calc-hedge-rate ${row.longLeg.apr < 0 ? "pos" : ""}">${row.longLeg.apr.toFixed(2)}%</span>
        </div>
        <div class="calc-hedge-row calc-hedge-short">
          <span class="calc-hedge-side">📉 SHORT</span>
          <div class="calc-hedge-detail">
            <div class="calc-hedge-venue">${escapeHtml(row.shortLeg.source)}</div>
            <div class="calc-hedge-market">${escapeHtml(row.shortLeg.market)}${row.shortLeg.quote ? "/" + escapeHtml(row.shortLeg.quote) : ""}</div>
          </div>
          <span class="calc-hedge-rate pos">${row.shortLeg.apr.toFixed(2)}%</span>
        </div>
        <div class="calc-hedge-net">
          Net spread: <b>+${row.apr.toFixed(2)}% APR</b>
          <span class="calc-hedge-hint">Капитал делится пополам: $${(amount/2).toFixed(0)} на каждую биржу</span>
        </div>
      </div>
    `
    : "";

  return `
    <div class="calc-panel" data-calc-for="${row._idx}">
      <div class="calc-input-row">
        <div class="calc-field">
          <label>Сумма (USD)</label>
          <input type="number" inputmode="decimal" min="1" step="100" data-calc-input="amount" value="${escapeHtml(state.amount)}">
        </div>
        <div class="calc-summary">
          <span class="calc-summary-label">APR:</span> <b>${row.apr.toFixed(2)}%</b>
          <span class="calc-summary-label">·  Fees входа/выхода:</span> <b>$${fees.toFixed(2)}</b>
        </div>
        <button class="position-add-btn" data-add-position="${row._idx}" type="button">+ В позиции</button>
      </div>
      ${hedgeBlock}
      <div class="calc-table-wrap">
        <table class="calc-table">
          <thead>
            <tr>
              <th>Горизонт</th>
              <th class="num">Gross</th>
              <th class="num">Fees</th>
              <th class="num">Net</th>
              <th class="num">Net APY</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${breakLine}
      ${verdict}
      ${baselineBlock}
      ${renderHistorySection(row)}
      ${renderBacktestBlock(row, amount)}
      <div class="recommendation-slot" data-rec-for="${row._idx}">
        ${renderRecommendationFromCache(row, amount, breakDays)}
      </div>
      <div class="calc-formula">${variableNote}</div>
    </div>
  `;
}

// ─── Backtest — "what would $X have earned in this row over the last N days?"
//
// Uses cached history points (the same data the sparkline draws). Computes
// daily yield = (avg APR in window) × days / 365 × amount − fees(amount).
// Caveats: linear, ignores compound; fine for directional intuition.
function renderBacktestBlock(row, amount) {
  if (amount <= 0) return "";
  const period = selectedPeriodFor(row);
  const cached = historyCache?.get?.(historyCacheKey(row, period));
  if (!cached || cached.points.length < 3) return "";
  const stats = statsFromPoints(cached.points);
  if (!stats) return "";

  const days = period;
  const apr = stats.avg / 100;
  const grossIfHeldThroughout = amount * apr * (days / 365);
  const fees = feesForCategory(row.category, amount);
  const net = grossIfHeldThroughout - fees;
  const isProfit = net > 0;

  return `
    <div class="backtest-block">
      <div class="backtest-title">⏪ Бэктест: что было бы при заходе ${period} дн назад?</div>
      <div class="backtest-row">
        <span class="backtest-label">Капитал:</span>
        <span class="backtest-val">$${amount.toFixed(0)}</span>
        <span class="backtest-label">Средний APR за период:</span>
        <span class="backtest-val">${stats.avg.toFixed(2)}%</span>
      </div>
      <div class="backtest-row">
        <span class="backtest-label">Заработал бы:</span>
        <span class="backtest-val ${isProfit ? "pos" : "neg"}">${net >= 0 ? "+" : "−"}$${Math.abs(net).toFixed(2)}</span>
        <span class="backtest-label">Реализованный APY:</span>
        <span class="backtest-val ${isProfit ? "pos" : "neg"}">${((net / amount) * (365 / days) * 100).toFixed(1)}%</span>
      </div>
      <p class="backtest-caveat">Расчёт линейный (gross = amount × avg APR × days/365 − fees). Реальная доходность зависит от compound, момента входа и точной траектории ставки. Это историческая «что было бы» оценка, не гарантия будущего.</p>
    </div>
  `;
}

// Recommendation slot uses cached history stats if available. If not, it
// shows a "loading" placeholder; once history loads, repaintHistorySection
// also re-paints the recommendation slot via repaintRecommendation().
function renderRecommendationFromCache(row, amount, breakDays) {
  const period = selectedPeriodFor(row);
  const cached = historyCache.get(historyCacheKey(row, period));
  const stats = cached ? statsFromPoints(cached.points) : null;
  return renderRecommendation(row, stats, amount, breakDays);
}

function repaintRecommendation(row) {
  if (!row || row._idx == null) return;
  const slot = document.querySelector(`.recommendation-slot[data-rec-for="${row._idx}"]`);
  if (!slot) return;
  const cstate = ensureCalcState(row);
  const amount = Math.max(0, Number(cstate.amount) || 0);
  const breakDays = breakEvenDays(row, amount);
  slot.innerHTML = renderRecommendationFromCache(row, amount, breakDays);
}

// Find the safest liquid alternative for opportunity-cost framing. Prefer top
// stable lending; fall back to top fixed yield. Skip if the row IS the
// baseline (no point comparing Aave USDC to Aave USDC).
function findBaselineComparison(row) {
  const stables = state.rows.filter(r =>
    r.liquid && r.category === "stable-lending" && r !== row,
  );
  if (stables.length > 0) {
    return stables.reduce((a, b) => b.apr > a.apr ? b : a);
  }
  const fixeds = state.rows.filter(r =>
    r.liquid && r.category === "fixed-yield" && r !== row,
  );
  if (fixeds.length > 0) {
    return fixeds.reduce((a, b) => b.apr > a.apr ? b : a);
  }
  return null;
}

function renderBaselineComparison(row, baseline, amount, bestProjection) {
  if (!bestProjection || amount <= 0) return "";
  // Use the same horizon to make the comparison apples-to-apples.
  const days = bestProjection.days;
  const baseProj = projectAt(baseline, amount, days);
  const horizonLabel = bestProjection.label;
  const delta = bestProjection.net - baseProj.net;
  const ratio = baseProj.net > 0 ? bestProjection.net / baseProj.net : null;

  let verdict;
  if (delta > 0) {
    const ratioStr = ratio && ratio > 1.5 ? ` (×${ratio.toFixed(1)})` : "";
    verdict = `<span class="calc-comparison-positive">+$${delta.toFixed(2)} больше${ratioStr}</span>`;
  } else if (delta < -0.5) {
    verdict = `<span class="calc-comparison-negative">−$${Math.abs(delta).toFixed(2)} меньше чем безопасный вариант</span>`;
  } else {
    verdict = `<span class="calc-comparison-neutral">≈ как у безопасной альтернативы</span>`;
  }

  return `
    <div class="calc-comparison">
      <div class="calc-comparison-label">Сравнение за <b>${escapeHtml(horizonLabel)}</b>:</div>
      <div class="calc-comparison-row">
        <span class="calc-comparison-pill">эта строка</span>
        <span class="calc-comparison-amt ${bestProjection.isProfit ? "pos" : "neg"}">${bestProjection.net >= 0 ? "+" : "−"}$${Math.abs(bestProjection.net).toFixed(2)}</span>
      </div>
      <div class="calc-comparison-row">
        <span class="calc-comparison-pill calc-comparison-base">${escapeHtml(baseline.source)} ${escapeHtml(baseline.market)} (${baseline.apr.toFixed(2)}%)</span>
        <span class="calc-comparison-amt ${baseProj.isProfit ? "pos" : "neg"}">${baseProj.net >= 0 ? "+" : "−"}$${Math.abs(baseProj.net).toFixed(2)}</span>
      </div>
      <div class="calc-comparison-verdict">${verdict}</div>
    </div>
  `;
}

const calcStates = new Map();  // row "key" → { amount }
function calcKey(row) {
  return `${row.source}|${row.market}|${row.category}`;
}
function ensureCalcState(row) {
  const key = calcKey(row);
  if (!calcStates.has(key)) {
    calcStates.set(key, { amount: "500" });
  }
  return calcStates.get(key);
}

function wireCalculatorListeners() {
  els.rows.querySelectorAll("tr.data-row").forEach(tr => {
    tr.addEventListener("click", e => {
      if (e.target.closest(".calc-panel")) return;
      if (e.target.closest(".star-btn")) return;  // star handled separately
      const idx = Number(tr.dataset.rowIndex);
      state.expandedRowIndex = state.expandedRowIndex === idx ? null : idx;
      render();
    });
  });
  els.rows.querySelectorAll(".star-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const idx = Number(btn.dataset.watchRow);
      const r = state.visibleRows[idx];
      if (!r) return;
      toggleWatched(r);
      render();
    });
  });
  els.rows.querySelectorAll(".compare-box").forEach(box => {
    box.addEventListener("click", e => e.stopPropagation());
    box.addEventListener("change", e => {
      const idx = Number(box.dataset.compareIdx);
      const r = state.visibleRows[idx];
      if (!r) return;
      const k = rowKey(r);
      if (box.checked) compareSelection.add(k);
      else compareSelection.delete(k);
      refreshCompareToolbar();
    });
  });
  // "+ В позиции" button — captures the current calculator amount into a
  // persistent position record. Stops click propagation so the row doesn't
  // collapse the calculator panel we're standing inside.
  els.rows.querySelectorAll(".position-add-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const idx = Number(btn.dataset.addPosition);
      const r = state.visibleRows[idx];
      if (!r) return;
      const cstate = ensureCalcState(r);
      const amount = Math.max(0, Number(cstate.amount) || 0);
      if (amount <= 0) {
        alert("Введите сумму больше нуля, чтобы добавить позицию.");
        return;
      }
      addPosition(r, amount);
      btn.textContent = "✓ Добавлено";
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = "+ В позиции";
        btn.disabled = false;
      }, 1500);
    });
  });
  els.rows.querySelectorAll(".calc-panel input[data-calc-input]").forEach(input => {
    attachCalcInputListener(input);
  });
  // Each expanded panel has one history section — wire its chips, attach
  // hover tooltip if data is already cached, and kick off the async fetch.
  els.rows.querySelectorAll(".history-section").forEach(section => {
    const idx = Number(section.dataset.historyFor);
    const row = state.visibleRows[idx];
    if (!row) return;
    wireHistoryChipListeners(section, row);
    const period = selectedPeriodFor(row);
    const cached = historyCache.get(historyCacheKey(row, period));
    if (cached && cached.points.length >= 2) {
      const sparkWrap = section.querySelector(".sparkline-wrap");
      attachSparklineHover(sparkWrap, cached.points);
    }
    ensureHistoryLoaded(row);
  });
}

function attachCalcInputListener(input) {
  input.addEventListener("input", e => {
    e.stopPropagation();
    const panel = input.closest(".calc-panel");
    const rowIdx = Number(panel.dataset.calcFor);
    const row = state.visibleRows[rowIdx];
    if (!row) return;
    const cstate = ensureCalcState(row);
    cstate[input.dataset.calcInput] = input.value;
    const newHtml = renderCalculator(row);
    const wrapper = document.createElement("tbody");
    wrapper.innerHTML = `<tr class="calc-row"><td colspan="6">${newHtml}</td></tr>`;
    const newPanel = wrapper.querySelector(".calc-panel");
    panel.replaceWith(newPanel);
    const which = input.dataset.calcInput;
    const restored = newPanel.querySelector(`input[data-calc-input="${which}"]`);
    if (restored) {
      restored.focus();
      try { restored.setSelectionRange(input.selectionStart, input.selectionEnd); } catch {}
    }
    newPanel.querySelectorAll("input[data-calc-input]").forEach(attachCalcInputListener);
    // Re-wire the history chip listeners on the new panel and kick off the
    // (cached) history load — recommendation block depends on it.
    const newHistorySection = newPanel.querySelector(".history-section");
    if (newHistorySection) {
      wireHistoryChipListeners(newHistorySection, row);
      ensureHistoryLoaded(row);
    }
  });
  input.addEventListener("click", e => e.stopPropagation());
}

// ─── Row + group renderers (separated so flat view and group view share code) ─

function renderRow(r, i) {
  const cat = CATEGORY_LABELS[r.category] ?? { label: r.category, badge: "" };
  const colour = aprColourClass(r.apr);
  const rowOpacity = r.liquid === false ? "opacity-70" : "";
  const marketBadge = r.liquid === false
    ? `<span class="ml-1 text-[10px] text-amber-400/70" title="Тонкий рынок — APR быстро меняется">●</span>`
    : "";
  const expanded = state.expandedRowIndex === i;
  const change = aprChange(r);
  const arrow = change.direction === "up"
    ? `<span class="apr-up" title="+${change.delta.toFixed(2)}% с прошлого обновления">▲</span>`
    : change.direction === "down"
      ? `<span class="apr-down" title="${change.delta.toFixed(2)}% с прошлого обновления">▼</span>`
      : "";
  const star = isWatched(r)
    ? `<button class="star-btn star-on" data-watch-row="${i}" aria-label="Убрать из избранного">★</button>`
    : `<button class="star-btn" data-watch-row="${i}" aria-label="В избранное">☆</button>`;
  const risk = riskScoreFor(r);
  const riskCls = riskColourClass(risk);
  const riskTitle = ["низкий","умеренный","средний","повышенный","высокий"][risk-1];
  const riskDot = `<span class="risk-dot ${riskCls}" title="Риск: ${riskTitle} (${risk}/5)"></span>`;
  const selected = compareSelection.has(rowKey(r));
  const compareBox = `<input type="checkbox" class="compare-box" data-compare-idx="${i}" ${selected ? "checked" : ""} title="Добавить в сравнение" />`;
  return `
    <tr class="data-row ${rowOpacity} ${expanded ? "expanded" : ""}" data-row-index="${i}">
      <td class="px-3 py-2 text-zinc-300">${compareBox}${star}${escapeHtml(r.source)}</td>
      <td class="px-3 py-2 font-mono text-xs text-zinc-100">${escapeHtml(r.market)}${r.quote ? `<span class="text-zinc-500">/${escapeHtml(r.quote)}</span>` : ""}${marketBadge}</td>
      <td class="px-3 py-2 hidden sm:table-cell"><span class="badge ${cat.badge}">${cat.label}</span></td>
      <td class="px-3 py-2 text-right font-mono ${colour}"><span class="apr-cell">${riskDot}${arrow}${fmtApr(r.apr)}</span></td>
      <td class="px-3 py-2 hidden md:table-cell text-zinc-400 text-xs">${r.fixed ? "фикс" : "плав"}</td>
      <td class="px-3 py-2 hidden lg:table-cell text-zinc-500 text-xs">${escapeHtml(r.note ?? "")}</td>
    </tr>
    ${expanded ? `<tr class="calc-row"><td colspan="6">${renderCalculator(r)}</td></tr>` : ""}
  `;
}

const TABLE_HEAD_HTML = `
  <thead class="bg-bg-elev text-zinc-400 text-[11px] uppercase tracking-wide">
    <tr>
      <th class="text-left px-3 py-2 font-medium">Источник</th>
      <th class="text-left px-3 py-2 font-medium">Рынок</th>
      <th class="text-left px-3 py-2 font-medium hidden sm:table-cell">Категория</th>
      <th class="text-right px-3 py-2 font-medium">APR</th>
      <th class="text-left px-3 py-2 font-medium hidden md:table-cell">Тип</th>
      <th class="text-left px-3 py-2 font-medium hidden lg:table-cell">Заметка</th>
    </tr>
  </thead>
`;

function renderFlatTable(filtered) {
  const visible = filtered.slice(0, 500);
  visible.forEach((r, i) => { r._idx = i; });
  state.visibleRows = visible;
  const rowsHtml = visible.map((r, i) => renderRow(r, i)).join("");
  const tail = filtered.length > 500
    ? `<tr><td colspan="6" class="px-3 py-3 text-center text-zinc-500 text-xs">Показано 500 из ${filtered.length} — уточните фильтр.</td></tr>`
    : "";
  return `
    <section class="bg-bg-card border border-border rounded-lg overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          ${TABLE_HEAD_HTML}
          <tbody class="divide-y divide-border/50">${rowsHtml}${tail}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderGroupedTable(filtered) {
  // Bucket by category.
  const byCategory = new Map();
  for (const r of filtered) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category).push(r);
  }
  // Each group's rows are pre-sorted by the user's `sort` choice already
  // (applyFilters does it). Sort the GROUPS by best APR descending so the
  // most attractive strategy band lands at the top.
  const groups = [...byCategory.entries()]
    .map(([cat, rows]) => ({
      cat,
      rows,
      bestApr: rows.length > 0 ? Math.max(...rows.map(r => r.apr)) : 0,
    }))
    .sort((a, b) => b.bestApr - a.bestApr);

  // Index continues across all groups so click handlers stay flat.
  state.visibleRows = [];
  let globalIdx = 0;
  const sections = groups.map(g => {
    const meta = CATEGORY_DESCRIPTIONS[g.cat] ?? { emoji: "📊", title: g.cat, desc: "" };
    const collapsed = state.collapsedGroups.has(g.cat);
    const showAll = state.showAllGroups.has(g.cat);
    const limit = collapsed ? 0 : (showAll ? g.rows.length : GROUP_DEFAULT_LIMIT);
    const visible = g.rows.slice(0, limit);

    // Stamp visible rows and append to global array
    const startIdx = globalIdx;
    visible.forEach((r) => {
      r._idx = globalIdx++;
      state.visibleRows.push(r);
    });

    const headerHtml = `
      <div class="group-header" data-toggle-group="${escapeHtml(g.cat)}">
        <span class="group-emoji">${meta.emoji}</span>
        <div class="group-title-block">
          <h3 class="group-title">${escapeHtml(meta.title)}</h3>
          <p class="group-desc">${escapeHtml(meta.desc)}</p>
        </div>
        <div class="group-stats">
          <div class="group-best-apr ${aprColourClass(g.bestApr)}">${g.bestApr.toFixed(2)}%</div>
          <div class="group-count">${g.rows.length} ${pluralRu(g.rows.length, "рынок", "рынка", "рынков")}</div>
        </div>
        <span class="group-toggle">${collapsed ? "▶" : "▼"}</span>
      </div>
    `;

    if (collapsed) {
      return `<section class="bg-bg-card border border-border rounded-lg overflow-hidden">${headerHtml}</section>`;
    }

    const rowsHtml = visible.map((r) => renderRow(r, r._idx)).join("");
    const hasMore = g.rows.length > limit;
    const showAllBtn = hasMore
      ? `<button class="show-all-btn" data-show-all-group="${escapeHtml(g.cat)}">Показать все ${g.rows.length}</button>`
      : (showAll && g.rows.length > GROUP_DEFAULT_LIMIT
          ? `<button class="show-all-btn" data-hide-extra-group="${escapeHtml(g.cat)}">Свернуть до ${GROUP_DEFAULT_LIMIT}</button>`
          : "");

    return `
      <section class="bg-bg-card border border-border rounded-lg overflow-hidden">
        ${headerHtml}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            ${TABLE_HEAD_HTML}
            <tbody class="divide-y divide-border/50">${rowsHtml}</tbody>
          </table>
        </div>
        ${showAllBtn}
      </section>
    `;
  });

  return sections.join("");
}

// Russian noun plural (1 рынок / 2-4 рынка / 5+ рынков).
function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function wireGroupListeners() {
  els.rows.querySelectorAll("[data-toggle-group]").forEach(el => {
    el.addEventListener("click", e => {
      // Avoid swallowing clicks on the show-all-btn rendered near the header
      if (e.target.closest(".show-all-btn")) return;
      const cat = el.dataset.toggleGroup;
      if (!cat) return;
      if (state.collapsedGroups.has(cat)) state.collapsedGroups.delete(cat);
      else state.collapsedGroups.add(cat);
      render();
    });
  });
  els.rows.querySelectorAll("[data-show-all-group]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const cat = btn.dataset.showAllGroup;
      state.showAllGroups.add(cat);
      render();
    });
  });
  els.rows.querySelectorAll("[data-hide-extra-group]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const cat = btn.dataset.hideExtraGroup;
      state.showAllGroups.delete(cat);
      render();
    });
  });
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

    const spreads = sustainable.filter(r => r.category === "cross-exchange-spread");
    if (spreads.length > 0) {
      const bestSpread = spreads.reduce((a, b) => b.apr > a.apr ? b : a);
      els.sum.spreadApr.textContent = fmtApr(bestSpread.apr);
      els.sum.spreadApr.className = `text-xl font-semibold mt-1 font-mono ${aprColourClass(bestSpread.apr)}`;
      els.sum.spreadSrc.textContent = `${bestSpread.market} (${bestSpread.longLeg?.source ?? "?"}→${bestSpread.shortLeg?.source ?? "?"})`;
    }

    els.sum.count.textContent = String(state.rows.length);
    const uniqueSources = new Set(state.rows.map(r => r.source));
    els.sum.sources.textContent = `${uniqueSources.size} источников`;
  }

  // Table / Groups
  if (filtered.length === 0) {
    els.rows.innerHTML = `<div class="bg-bg-card border border-border rounded-lg px-3 py-8 text-center text-zinc-500">Под фильтры ничего не подошло.</div>`;
    state.visibleRows = [];
  } else {
    // When the user picked a specific category in the filter, the group view
    // is redundant — render a flat table inside one card.
    const usingFlatView = !!state.filters.category;
    els.rows.innerHTML = usingFlatView
      ? renderFlatTable(filtered)
      : renderGroupedTable(filtered);
    wireCalculatorListeners();
    wireGroupListeners();
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

// ─── Cross-exchange funding-rate spread analyser ─────────────────────────────
//
// Build synthetic rows that pair the best long-leg exchange (lowest/most
// negative funding) with the best short-leg exchange (highest positive
// funding) for each crypto-perp symbol. The synthetic APR is the spread —
// the rate you'd capture as a delta-neutral position holding both legs.
//
// Liquidity is propagated: a spread is `liquid` only when BOTH legs are
// liquid. Equity/index perps (nonCrypto) are excluded — there's no spot
// venue to settle against.

const SPREAD_MIN_APR_TO_SURFACE = 3;  // hide micro-spreads — pure noise

function computeCrossExchangeSpreads(rows) {
  const fundingRows = rows.filter(r =>
    r.category === "funding-rate" && !r.nonCrypto && !r.suspect,
  );
  const bySymbol = new Map();
  for (const r of fundingRows) {
    if (!r.market) continue;
    if (!bySymbol.has(r.market)) bySymbol.set(r.market, []);
    bySymbol.get(r.market).push(r);
  }

  const spreads = [];
  for (const [market, group] of bySymbol) {
    if (group.length < 2) continue;
    // Prefer liquid candidates. Fall back to the whole group if fewer than two
    // legs are liquid — the row will then be marked non-liquid itself.
    const liquidGroup = group.filter(r => r.liquid);
    const candidates = liquidGroup.length >= 2 ? liquidGroup : group;

    let longLeg = candidates[0], shortLeg = candidates[0];
    for (const r of candidates) {
      if (r.apr < longLeg.apr) longLeg = r;
      if (r.apr > shortLeg.apr) shortLeg = r;
    }
    if (longLeg === shortLeg) continue;
    const spread = shortLeg.apr - longLeg.apr;
    if (spread < SPREAD_MIN_APR_TO_SURFACE) continue;

    spreads.push({
      source: "Cross-exchange",
      market,
      quote: "",
      category: "cross-exchange-spread",
      apr: spread,
      fixed: false,
      liquid: !!longLeg.liquid && !!shortLeg.liquid,
      note: `long ${longLeg.source} (${longLeg.apr.toFixed(2)}%) + short ${shortLeg.source} (${shortLeg.apr.toFixed(2)}%)`,
      longLeg,
      shortLeg,
    });
  }
  return spreads;
}

async function refreshData() {
  els.refresh.disabled = true;
  els.refresh.textContent = "↻ Загрузка…";

  // Snapshot APRs from the prior fetch so the renderer can show ↑/↓ arrows.
  // Only do this if we actually had data — first load shows no arrows.
  if (state.rows.length > 0) {
    const snapshot = new Map();
    for (const r of state.rows) snapshot.set(rowKey(r), r.apr);
    state.previousApr = snapshot;
  }

  const results = await Promise.all([
    // Binance intentionally removed — user is in RU/CIS where it's blocked
    // without VPN, and even funding-rate signals from Binance can't be
    // arbitraged if he can't physically trade there.
    fetchBybit(),
    fetchHyperliquid(),
    fetchMexcFunding(),
    fetchGateFunding(),
    fetchHtxFunding(),
    fetchDefiLlama(),
    fetchPendleBoros(),
  ]);

  const rows = [];
  const failures = [];
  for (const r of results) {
    if (r.ok) rows.push(...r.data);
    else failures.push({ source: r.source, error: r.error });
  }
  // Derive cross-exchange spreads from funding-rate rows and append them as
  // synthetic rows in their own category.
  rows.push(...computeCrossExchangeSpreads(rows));

  state.rows = rows;
  state.failures = failures;
  state.lastUpdated = Date.now();
  render();

  els.refresh.disabled = false;
  els.refresh.textContent = "↻ Обновить";
}

// Returns: { delta: number, direction: "up"|"down"|"same"|null }
// null direction = no prior snapshot, don't show an indicator yet.
function aprChange(r) {
  const prev = state.previousApr.get(rowKey(r));
  if (prev == null) return { delta: 0, direction: null };
  const delta = r.apr - prev;
  // Tiny moves on stable-lending pools (0.01%) are noise; suppress them.
  const epsilon = r.category === "stable-lending" ? 0.05 : 0.01;
  if (Math.abs(delta) < epsilon) return { delta: 0, direction: "same" };
  return { delta, direction: delta > 0 ? "up" : "down" };
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
els.watchlistOnly.checked = state.filters.watchlistOnly;

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
els.watchlistOnly.addEventListener("change", e => {
  state.filters.watchlistOnly = e.target.checked;
  saveFilters();
  render();
});

// Quick filter presets — one-click setups for common workflows. Each preset
// overwrites the filter state wholesale; user can tweak from there.
const PRESETS = {
  // "Безопасные" — стейблы + фикс. доходность с разумным APR и достаточной
  // ликвидностью. Технически filter показывает category=stable-lending здесь;
  // через group-view пользователь увидит fixed-yield рядом, потому что
  // ликвидность включена.
  safe:    { search: "", category: "stable-lending", minApr: 4,  maxApr: 25,  liquidOnly: true,  watchlistOnly: false, sort: "apr-desc" },
  stables: { search: "", category: "stable-lending", minApr: 5,  maxApr: null, liquidOnly: true, watchlistOnly: false, sort: "apr-desc" },
  pendle:  { search: "", category: "fixed-yield",    minApr: 15, maxApr: null, liquidOnly: true, watchlistOnly: false, sort: "apr-desc" },
  spreads: { search: "", category: "cross-exchange-spread", minApr: 10, maxApr: null, liquidOnly: true, watchlistOnly: false, sort: "apr-desc" },
  spikes:  { search: "", category: "funding-rate",   minApr: 50, maxApr: null, liquidOnly: true, watchlistOnly: false, sort: "apr-desc" },
  reset:   { search: "", category: "",               minApr: null, maxApr: null, liquidOnly: false, watchlistOnly: false, sort: "apr-desc" },
};

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  Object.assign(state.filters, preset);
  // Reflect into the input controls
  els.search.value = state.filters.search ?? "";
  els.category.value = state.filters.category ?? "";
  els.sort.value = state.filters.sort ?? "apr-desc";
  els.minApr.value = state.filters.minApr ?? "";
  els.maxApr.value = state.filters.maxApr ?? "";
  els.liquidOnly.checked = !!state.filters.liquidOnly;
  els.watchlistOnly.checked = !!state.filters.watchlistOnly;
  saveFilters();
  render();
}

document.querySelectorAll(".preset-btn[data-preset]").forEach(btn => {
  btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
});

// ─── Capital allocator ────────────────────────────────────────────────────────
//
// Naive greedy + per-category cap. Sorts liquid rows by APR descending,
// allocates greedy from the top, but never lets a single category exceed its
// cap of the total. Designed to land at 4-7 positions with the top APR
// available, while still forcing diversification (no putting 100% into
// the single hottest Pendle PT).

const CATEGORY_ALLOC_CAP = {
  "stable-lending":        0.50,  // up to 50% — это safe layer
  "fixed-yield":           0.40,
  "delta-neutral":         0.25,  // Ethena yield variable
  "restaking":             0.20,
  "cross-exchange-spread": 0.20,  // requires capital on 2 venues
  "funding-rate":          0.15,  // single-venue, sensitive to spike decay
  "leveraged-stable":      0.10,
};
const PER_POSITION_MAX_PCT = 0.30;  // никогда больше 30% в одну строку
const MIN_TICKET_USD = 50;          // под $50 не имеет смысла открывать

function computeAllocation(totalUsd, maxRisk) {
  if (totalUsd < MIN_TICKET_USD * 2) {
    return { allocations: [], unallocated: totalUsd, note: `Минимум $${MIN_TICKET_USD * 2} для разумной диверсификации` };
  }

  // Universe: liquid, non-suspect, risk ≤ user's tolerance, excluding the
  // synthetic Cross-exchange rows (we keep them but with the spread cap).
  const candidates = state.rows
    .filter(r => r.liquid && !r.suspect && riskScoreFor(r) <= maxRisk && r.apr > 0)
    .sort((a, b) => b.apr - a.apr);

  const categoryTotals = new Map();
  const allocations = [];
  let remaining = totalUsd;
  const perPositionMax = totalUsd * PER_POSITION_MAX_PCT;

  for (const row of candidates) {
    if (remaining < MIN_TICKET_USD) break;
    const cap = (CATEGORY_ALLOC_CAP[row.category] ?? 0.10) * totalUsd;
    const inCat = categoryTotals.get(row.category) ?? 0;
    const room = cap - inCat;
    if (room < MIN_TICKET_USD) continue;
    const amount = Math.min(remaining, perPositionMax, room);
    if (amount < MIN_TICKET_USD) continue;
    allocations.push({ row, amount: Math.round(amount) });
    categoryTotals.set(row.category, inCat + amount);
    remaining -= amount;
    if (allocations.length >= 7) break;
  }

  // Estimate annual income from the proposed allocation
  let annualIncome = 0;
  for (const a of allocations) {
    annualIncome += a.amount * (a.row.apr / 100);
  }

  return {
    allocations,
    unallocated: Math.max(0, Math.round(remaining)),
    annualIncome,
    monthlyIncome: annualIncome / 12,
  };
}

function renderAllocation(plan) {
  const root = document.getElementById("alloc-result");
  if (!root) return;
  if (plan.note) {
    root.innerHTML = `<p class="text-amber-400 text-sm">${escapeHtml(plan.note)}</p>`;
    root.classList.remove("hidden");
    return;
  }
  if (plan.allocations.length === 0) {
    root.innerHTML = `<p class="text-zinc-500 text-sm">Не нашёл подходящих стратегий под заданный риск. Попробуй увеличить риск или подожди следующего обновления.</p>`;
    root.classList.remove("hidden");
    return;
  }

  const totalAllocated = plan.allocations.reduce((s, a) => s + a.amount, 0);
  const rows = plan.allocations.map(a => {
    const cat = CATEGORY_LABELS[a.row.category] ?? { label: a.row.category, badge: "" };
    const risk = riskScoreFor(a.row);
    const monthly = a.amount * (a.row.apr / 100) / 12;
    const pctOfTotal = ((a.amount / (totalAllocated + plan.unallocated)) * 100).toFixed(0);
    return `
      <tr class="border-b border-border/30">
        <td class="px-2 py-2 font-mono text-xs text-zinc-200">$${a.amount}</td>
        <td class="px-2 py-2 text-zinc-400 text-xs">${pctOfTotal}%</td>
        <td class="px-2 py-2 text-zinc-100 text-xs">${escapeHtml(a.row.source)}<br><span class="font-mono text-zinc-500">${escapeHtml(a.row.market)}</span></td>
        <td class="px-2 py-2"><span class="badge ${cat.badge}">${cat.label}</span></td>
        <td class="px-2 py-2 text-right font-mono text-xs ${aprColourClass(a.row.apr)}">${a.row.apr.toFixed(2)}%</td>
        <td class="px-2 py-2"><span class="risk-dot ${riskColourClass(risk)}"></span></td>
        <td class="px-2 py-2 text-right font-mono text-xs pos">+$${monthly.toFixed(2)}/мес</td>
      </tr>
    `;
  }).join("");

  root.innerHTML = `
    <div class="overflow-x-auto">
      <table class="w-full text-xs">
        <thead class="text-[10px] uppercase tracking-wide text-zinc-500">
          <tr>
            <th class="text-left px-2 py-1">Сумма</th>
            <th class="text-left px-2 py-1">%</th>
            <th class="text-left px-2 py-1">Куда</th>
            <th class="text-left px-2 py-1">Категория</th>
            <th class="text-right px-2 py-1">APR</th>
            <th class="text-left px-2 py-1">Риск</th>
            <th class="text-right px-2 py-1">Доход/мес</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="alloc-summary">
      <span>Распределено: <b>$${totalAllocated}</b></span>
      <span>Остаток: <b>$${plan.unallocated}</b></span>
      <span>Ожидаемый доход: <b class="text-emerald-400">+$${plan.monthlyIncome.toFixed(2)}/мес</b> · <span class="text-zinc-400">+$${plan.annualIncome.toFixed(2)}/год</span></span>
    </div>
    <p class="text-[11px] text-zinc-500 mt-2">⚠ Оценка линейная (без compound). APR могут меняться. Это suggested allocation — не инвестрекомендация.</p>
  `;
  root.classList.remove("hidden");
}

// Wire allocator inputs
const allocTotal = document.getElementById("alloc-total");
const allocRisk = document.getElementById("alloc-risk");
const allocCompute = document.getElementById("alloc-compute");
if (allocCompute && allocTotal && allocRisk) {
  // Restore last values from localStorage
  try {
    const saved = JSON.parse(localStorage.getItem("soomqa.allocator.v1") || "{}");
    if (saved.total) allocTotal.value = saved.total;
    if (saved.risk) allocRisk.value = saved.risk;
  } catch {}

  function runAllocator() {
    const total = Number(allocTotal.value) || 0;
    const risk = Number(allocRisk.value) || 3;
    try {
      localStorage.setItem("soomqa.allocator.v1", JSON.stringify({ total, risk }));
    } catch {}
    if (state.rows.length === 0) {
      document.getElementById("alloc-result").innerHTML = `<p class="text-zinc-500 text-sm">Подожди первой загрузки данных…</p>`;
      document.getElementById("alloc-result").classList.remove("hidden");
      return;
    }
    const plan = computeAllocation(total, risk);
    renderAllocation(plan);
  }
  allocCompute.addEventListener("click", runAllocator);
  allocTotal.addEventListener("keydown", e => { if (e.key === "Enter") runAllocator(); });
}

// ─── Side-by-side compare panel ───────────────────────────────────────────────

const compareSelection = new Set();  // rowKey strings

function refreshCompareToolbar() {
  const openBtn = document.getElementById("compare-open");
  const clearBtn = document.getElementById("compare-clear");
  const countEl = document.getElementById("compare-count");
  if (!openBtn) return;
  if (compareSelection.size > 0) {
    openBtn.classList.remove("hidden");
    clearBtn.classList.remove("hidden");
    countEl.textContent = String(compareSelection.size);
  } else {
    openBtn.classList.add("hidden");
    clearBtn.classList.add("hidden");
  }
}

function renderComparePanel() {
  const panel = document.getElementById("compare-panel");
  const content = document.getElementById("compare-content");
  if (!panel || !content) return;

  const selected = state.rows.filter(r => compareSelection.has(rowKey(r)));
  if (selected.length === 0) {
    panel.classList.add("hidden");
    return;
  }

  // Use the largest amount from any open calculator state — fallback $500.
  const amount = 500;

  const horizons = [
    { label: "1 день", days: 1 },
    { label: "1 неделя", days: 7 },
    { label: "1 месяц", days: 30 },
    { label: "1 год", days: 365 },
  ];

  let html = `<table class="compare-table"><thead><tr><th>Метрика</th>`;
  for (const r of selected) {
    html += `<th>${escapeHtml(r.source)}<br><span class="text-zinc-500">${escapeHtml(r.market)}</span></th>`;
  }
  html += `</tr></thead><tbody>`;

  // APR row
  html += `<tr><td>APR</td>`;
  for (const r of selected) {
    html += `<td class="num ${aprColourClass(r.apr)}">${fmtApr(r.apr)}</td>`;
  }
  html += `</tr>`;

  // Category
  html += `<tr><td>Категория</td>`;
  for (const r of selected) {
    const cat = CATEGORY_LABELS[r.category] ?? { label: r.category, badge: "" };
    html += `<td><span class="badge ${cat.badge}">${cat.label}</span></td>`;
  }
  html += `</tr>`;

  // Risk
  html += `<tr><td>Риск</td>`;
  for (const r of selected) {
    const risk = riskScoreFor(r);
    html += `<td><span class="risk-dot ${riskColourClass(risk)}"></span> ${risk}/5</td>`;
  }
  html += `</tr>`;

  // Liquid
  html += `<tr><td>Ликвидный</td>`;
  for (const r of selected) {
    html += `<td>${r.liquid ? "✓" : "✗"}</td>`;
  }
  html += `</tr>`;

  // Fees
  html += `<tr><td>Fees on $${amount}</td>`;
  for (const r of selected) {
    html += `<td class="num">$${feesForCategory(r.category, amount).toFixed(2)}</td>`;
  }
  html += `</tr>`;

  // Horizon net APY projections
  for (const h of horizons) {
    html += `<tr><td>${h.label}: net $</td>`;
    for (const r of selected) {
      const proj = projectAt(r, amount, h.days);
      html += `<td class="num ${proj.isProfit ? "pos" : "neg"}">${proj.net >= 0 ? "+" : "−"}$${Math.abs(proj.net).toFixed(2)}</td>`;
    }
    html += `</tr>`;
  }

  // Break-even
  html += `<tr><td>Break-even</td>`;
  for (const r of selected) {
    const days = breakEvenDays(r, amount);
    html += `<td class="num">${days == null ? "—" : formatDuration(days, r)}</td>`;
  }
  html += `</tr>`;

  html += `</tbody></table>`;
  html += `<p class="text-[11px] text-zinc-500 mt-3">Базовая сумма $${amount}. Открой строку в таблице для калькулятора с твоей суммой и горизонтами.</p>`;
  content.innerHTML = html;
  panel.classList.remove("hidden");
}

const compareOpenBtn = document.getElementById("compare-open");
const compareCloseBtn = document.getElementById("compare-close");
const compareClearBtn = document.getElementById("compare-clear");
if (compareOpenBtn) {
  compareOpenBtn.addEventListener("click", renderComparePanel);
}
if (compareCloseBtn) {
  compareCloseBtn.addEventListener("click", () => {
    document.getElementById("compare-panel")?.classList.add("hidden");
  });
}
if (compareClearBtn) {
  compareClearBtn.addEventListener("click", () => {
    compareSelection.clear();
    refreshCompareToolbar();
    document.getElementById("compare-panel")?.classList.add("hidden");
    render();
  });
}

// ─── Heatmap: exchanges (rows) × symbols (cols) → APR colour cells ───────────

const HEATMAP_TOP_N_SYMBOLS = 20;

function renderHeatmap() {
  const section = document.getElementById("heatmap-section");
  const content = document.getElementById("heatmap-content");
  if (!section || !content) return;

  const fundingRows = state.rows.filter(r =>
    r.category === "funding-rate" && !r.nonCrypto,
  );
  if (fundingRows.length === 0) {
    content.innerHTML = `<p class="text-zinc-500 text-sm text-center py-4">Нет данных funding rates.</p>`;
    return;
  }

  // Group by exchange and by symbol
  const exchanges = [...new Set(fundingRows.map(r => r.source))].sort();
  // Pick top N symbols by aggregate volume across exchanges
  const symbolVolume = new Map();
  for (const r of fundingRows) {
    symbolVolume.set(r.market, (symbolVolume.get(r.market) ?? 0) + (r.volumeUsd ?? 0));
  }
  const symbols = [...symbolVolume.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, HEATMAP_TOP_N_SYMBOLS)
    .map(([s]) => s);

  // Build cell lookup
  const cellByKey = new Map();
  for (const r of fundingRows) {
    cellByKey.set(`${r.source}|${r.market}`, r);
  }

  function aprToColor(apr) {
    if (apr == null) return "#1a1a24";
    // Scale -50% (red) → 0 (neutral) → +50% (green) → cap
    const clamped = Math.max(-50, Math.min(50, apr));
    if (clamped >= 0) {
      const t = clamped / 50;        // 0..1
      const r = Math.round(26 + t * (74 - 26));
      const g = Math.round(26 + t * (222 - 26));
      const b = Math.round(36 + t * (128 - 36));
      return `rgb(${r},${g},${b})`;
    } else {
      const t = -clamped / 50;
      const r = Math.round(26 + t * (248 - 26));
      const g = Math.round(26 + t * (113 - 26));
      const b = Math.round(36 + t * (113 - 36));
      return `rgb(${r},${g},${b})`;
    }
  }

  // Render as a table with sticky first column
  let html = `<table class="heatmap-table">`;
  html += `<thead><tr><th class="heatmap-corner"></th>`;
  for (const s of symbols) {
    html += `<th class="heatmap-symbol-head">${escapeHtml(s)}</th>`;
  }
  html += `</tr></thead><tbody>`;
  for (const ex of exchanges) {
    html += `<tr><th class="heatmap-exchange-head">${escapeHtml(ex)}</th>`;
    for (const s of symbols) {
      const row = cellByKey.get(`${ex}|${s}`);
      if (!row) {
        html += `<td class="heatmap-cell heatmap-empty">—</td>`;
      } else {
        const colour = aprToColor(row.apr);
        const label = row.apr.toFixed(1);
        const opacity = row.liquid ? "1" : "0.4";
        html += `<td class="heatmap-cell" style="background:${colour};opacity:${opacity}" title="${escapeHtml(ex)} · ${escapeHtml(s)} · ${row.apr.toFixed(2)}%">${label}</td>`;
      }
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  html += `<p class="text-[11px] text-zinc-500 mt-3">Цвет: 🟢 ≥+50% · 🔴 ≤−50%. Полупрозрачные ячейки — non-liquid. Топ ${HEATMAP_TOP_N_SYMBOLS} символов по совокупному объёму.</p>`;
  content.innerHTML = html;
}

const heatmapToggle = document.getElementById("heatmap-toggle");
const heatmapSection = document.getElementById("heatmap-section");
const heatmapClose = document.getElementById("heatmap-close");
if (heatmapToggle && heatmapSection) {
  heatmapToggle.addEventListener("click", () => {
    heatmapSection.classList.remove("hidden");
    heatmapToggle.classList.add("hidden");
    renderHeatmap();
  });
}
if (heatmapClose) {
  heatmapClose.addEventListener("click", () => {
    heatmapSection.classList.add("hidden");
    heatmapToggle.classList.remove("hidden");
  });
}

// Wallet quick-look — DeBank deep link. We persist the address in localStorage
// so the user doesn't have to retype it every visit, but never send it anywhere
// from this page; we just open DeBank in a new tab.
const WALLET_KEY = "soomqa.wallet.v1";
const walletInput = document.getElementById("wallet-address");
const walletButton = document.getElementById("open-debank");
if (walletInput) {
  walletInput.value = localStorage.getItem(WALLET_KEY) || "";
  walletInput.addEventListener("input", e => {
    try { localStorage.setItem(WALLET_KEY, e.target.value.trim()); } catch {}
  });
}
if (walletButton) {
  walletButton.addEventListener("click", () => {
    const addr = (walletInput.value || "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      alert("Введи корректный EVM-адрес: 0x… 40 hex-символов.");
      return;
    }
    window.open(`https://debank.com/profile/${addr}`, "_blank", "noopener,noreferrer");
  });
  walletInput?.addEventListener("keydown", e => {
    if (e.key === "Enter") walletButton.click();
  });
}
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

// Initial render of persisted positions (so the panel shows even before the
// first fetch completes — APR delta needs live data but invested amount and
// estimated earned only need the stored timestamp).
renderPositions();

// Initial fetch + periodic refresh
refreshData().then(renderPositions);  // re-render positions once we have live APRs
startRefreshTimer();

// Also re-render positions on every periodic refresh so the "current APR"
// column updates.
setInterval(() => {
  if (positions.length > 0) renderPositions();
}, REFRESH_MS);
