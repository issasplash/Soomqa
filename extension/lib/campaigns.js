// Registry of airdrop campaigns we check eligibility against.
//
// Each campaign defines a `score(snapshot)` function that returns:
//   { status: "eligible" | "partial" | "no", reason: string }
//
// Eligibility heuristics here are EDUCATED GUESSES based on patterns from past
// airdrops (LayerZero, Arbitrum, Optimism, zkSync). Real criteria are never
// public until snapshot — we approximate Sybil-resistant activity.
//
// To add a new campaign: append an object below. The UI picks it up automatically.

export const campaigns = [
  {
    id: "linea",
    name: "Linea",
    chain: "Linea (testnet activity)",
    status: "active",
    notes: "Bridge to Linea and interact with dApps. Tracked via Linea Surge points.",
    score: (snap) => {
      // Linea isn't in our supported chains snapshot yet; mark as "check manually"
      return {
        status: "partial",
        reason: "Visit Linea Surge dashboard to check points",
      };
    },
  },
  {
    id: "base",
    name: "Base Ecosystem",
    chain: "Base",
    status: "ongoing",
    notes: "No confirmed airdrop, but ecosystem projects (Aerodrome, Friend.tech, etc.) drop to Base users.",
    score: (snap) => {
      const base = snap.base || {};
      if (base.txCount === null) return { status: "no", reason: "No data" };
      if (base.txCount >= 20 && base.balanceEth >= 0.01) {
        return { status: "eligible", reason: `${base.txCount} txns, ${base.balanceEth.toFixed(4)} ETH on Base` };
      }
      if (base.txCount >= 5) {
        return { status: "partial", reason: `${base.txCount} txns — increase activity` };
      }
      return { status: "no", reason: "Low Base activity" };
    },
  },
  {
    id: "arbitrum-stip",
    name: "Arbitrum STIP / Future Rounds",
    chain: "Arbitrum",
    status: "ongoing",
    notes: "Arbitrum has run multiple airdrop rounds. Active Arbitrum users often qualify for protocol-level drops on the chain.",
    score: (snap) => {
      const arb = snap.arbitrum || {};
      if (arb.txCount === null) return { status: "no", reason: "No data" };
      if (arb.txCount >= 50 && arb.balanceEth >= 0.05) {
        return { status: "eligible", reason: `${arb.txCount} txns, ${arb.balanceEth.toFixed(4)} ETH on Arbitrum` };
      }
      if (arb.txCount >= 10) {
        return { status: "partial", reason: `${arb.txCount} txns — more activity needed` };
      }
      return { status: "no", reason: "Low Arbitrum activity" };
    },
  },
  {
    id: "optimism-rpgf",
    name: "Optimism RetroPGF / Drops",
    chain: "Optimism",
    status: "ongoing",
    notes: "Optimism has done 4+ airdrop rounds. Continued OP-chain activity remains a strong signal.",
    score: (snap) => {
      const op = snap.optimism || {};
      if (op.txCount === null) return { status: "no", reason: "No data" };
      if (op.txCount >= 30 && op.balanceEth >= 0.02) {
        return { status: "eligible", reason: `${op.txCount} txns, ${op.balanceEth.toFixed(4)} ETH on Optimism` };
      }
      if (op.txCount >= 5) {
        return { status: "partial", reason: `${op.txCount} txns — increase usage` };
      }
      return { status: "no", reason: "Low Optimism activity" };
    },
  },
  {
    id: "monad",
    name: "Monad",
    chain: "Monad (testnet)",
    status: "upcoming",
    notes: "Mainnet TBA. Testnet activity expected to be the eligibility signal. Not yet tracked automatically.",
    score: (_snap) => {
      return {
        status: "partial",
        reason: "Use Monad testnet — manual tracking only for now",
      };
    },
  },
  {
    id: "megaeth",
    name: "MegaETH",
    chain: "MegaETH (testnet)",
    status: "upcoming",
    notes: "High-throughput L2. Testnet participation likely matters.",
    score: (_snap) => {
      return {
        status: "partial",
        reason: "Participate in MegaETH testnet — manual check",
      };
    },
  },
];
