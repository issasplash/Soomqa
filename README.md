# Soomqa

Chrome extension that checks your EVM wallets against current and upcoming airdrop campaigns. Multi-chain (Ethereum, Base, Arbitrum, Optimism), multi-wallet, with eligibility heuristics based on transaction count, native balance, and protocol-level activity.

**Status:** v0.1 MVP. Pre-Chrome Web Store. Local install only.

## Quick start

See [`docs/SETUP.md`](docs/SETUP.md) for the step-by-step Mac install guide.

```bash
git clone https://github.com/issasplash/soomqa.git
cd soomqa
cp extension/lib/config.example.js extension/lib/config.js
# edit config.js with your Etherscan + Alchemy keys
# then load extension/ as unpacked in chrome://extensions
```

## How it works

1. You add EVM wallet addresses (up to 3 on free tier).
2. The extension fetches transaction count and native balance for each address on each supported chain via Etherscan V2.
3. For each campaign defined in [`extension/lib/campaigns.js`](extension/lib/campaigns.js), a scoring function returns `eligible` / `partial` / `not yet` with a reason.
4. Results render in the popup. No data leaves your browser except direct calls to Etherscan/Alchemy.

## Adding a new campaign

Open `extension/lib/campaigns.js`, append an object to the `campaigns` array:

```js
{
  id: "new-campaign",
  name: "Display name",
  chain: "Ethereum",
  status: "active",
  notes: "Why this might drop tokens.",
  score: (snapshot) => {
    const data = snapshot.ethereum;
    if (data.txCount >= 50) return { status: "eligible", reason: "Heavy ETH user" };
    return { status: "no", reason: "Not enough activity" };
  },
}
```

The popup picks it up on next reload.

## Roadmap

- v0.1 — MVP: 4 EVM chains, txn count + balance heuristics, free tier only
- v0.2 — ExtensionPay integration, Pro tier (unlimited wallets, more campaigns)
- v0.3 — Solana support (Helius API)
- v0.4 — Background eligibility checks + push notifications on status change
- v0.5 — CSV export of all wallet activity (tax-prep helper)
