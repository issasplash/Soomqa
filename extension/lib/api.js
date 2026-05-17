import { config } from "./config.js";

const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";

const CHAIN_IDS = {
  ethereum: 1,
  optimism: 10,
  arbitrum: 42161,
  base: 8453,
};

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Returns the number of transactions sent FROM the address on a given chain.
// Uses Etherscan V2 unified endpoint — one key works for all supported chains.
export async function getTxCount(address, chain) {
  const chainId = CHAIN_IDS[chain];
  if (!chainId) return { ok: false, error: `Unknown chain: ${chain}` };

  const url = new URL(ETHERSCAN_V2);
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("module", "proxy");
  url.searchParams.set("action", "eth_getTransactionCount");
  url.searchParams.set("address", address);
  url.searchParams.set("tag", "latest");
  url.searchParams.set("apikey", config.ETHERSCAN_API_KEY);

  const result = await fetchJson(url.toString());
  if (!result.ok) return result;

  // Etherscan returns the nonce as hex. Nonce ≈ tx count sent from this address.
  const hex = result.data.result;
  if (typeof hex !== "string" || !hex.startsWith("0x")) {
    return { ok: false, error: "Unexpected response shape" };
  }
  return { ok: true, data: parseInt(hex, 16) };
}

// Native token balance (ETH on L1/L2) in wei. Returns a BigInt-safe string.
export async function getNativeBalance(address, chain) {
  const chainId = CHAIN_IDS[chain];
  if (!chainId) return { ok: false, error: `Unknown chain: ${chain}` };

  const url = new URL(ETHERSCAN_V2);
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "balance");
  url.searchParams.set("address", address);
  url.searchParams.set("tag", "latest");
  url.searchParams.set("apikey", config.ETHERSCAN_API_KEY);

  const result = await fetchJson(url.toString());
  if (!result.ok) return result;
  if (result.data.status === "0") {
    return { ok: false, error: result.data.message || "API error" };
  }
  return { ok: true, data: result.data.result };
}

// Helper: convert wei (string) to ETH as a float. Lossy for huge balances, fine for UI.
export function weiToEth(wei) {
  if (!wei) return 0;
  return Number(BigInt(wei)) / 1e18;
}

// Aggregate snapshot across all chains we care about. Used by campaigns.js
// to score wallet activity. One call per chain — be mindful of rate limits.
export async function getWalletSnapshot(address) {
  const chains = Object.keys(CHAIN_IDS);
  const snapshot = {};

  for (const chain of chains) {
    const [txRes, balRes] = await Promise.all([
      getTxCount(address, chain),
      getNativeBalance(address, chain),
    ]);
    snapshot[chain] = {
      txCount: txRes.ok ? txRes.data : null,
      balanceWei: balRes.ok ? balRes.data : null,
      balanceEth: balRes.ok ? weiToEth(balRes.data) : null,
      error: txRes.ok && balRes.ok ? null : (txRes.error || balRes.error),
    };
  }

  return snapshot;
}
