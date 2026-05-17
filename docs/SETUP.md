# Soomqa — Setup Guide

This is the human-facing checklist for getting the extension running on your Mac and (eventually) published to the Chrome Web Store.

## Phase 1 — Run locally (15 min)

You'll need this once to test that everything works.

### 1. Get API keys

Both are free. Each has a generous free tier; you won't hit limits in development.

- **Etherscan V2 API key** — https://etherscan.io/myapikey
  - Create an account, click "Add" to generate a key.
  - V2 keys work for Ethereum, Base, Arbitrum, and Optimism with one key.
- **Alchemy API key** — https://dashboard.alchemy.com (optional for MVP, used later for token holdings)
  - Sign up, create an app, copy the API key from the dashboard.

### 2. Clone and configure

On your Mac, open Terminal:

```bash
git clone https://github.com/issasplash/soomqa.git
cd soomqa
cp extension/lib/config.example.js extension/lib/config.js
```

Open `extension/lib/config.js` in any text editor and paste your keys:

```js
export const config = {
  ETHERSCAN_API_KEY: "abc123...",  // your Etherscan V2 key
  ALCHEMY_API_KEY: "xyz789...",    // your Alchemy key (optional for MVP)
};
```

Save the file. (It's gitignored — your keys never get committed.)

### 3. Load into Chrome

1. Open Chrome → go to `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder inside the cloned repo
5. The Soomqa icon appears in your toolbar. Click it.

### 4. Test

- Paste any EVM wallet address into the input (your own, or a known active one like `vitalik.eth` resolved → `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`)
- Click **Add**
- Eligibility results render below within ~2 seconds

If something doesn't work:
1. In `chrome://extensions`, click "service worker" or "errors" on the Soomqa card
2. Copy the error message, paste it back to Claude in the next session

After any code change, click the reload arrow on the Soomqa card to pick it up.

## Phase 2 — Chrome Web Store submission (~1 hour, when MVP is polished)

### Prerequisites

- **Chrome Web Store Developer Account** — https://chrome.google.com/webstore/devconsole
  - One-time $5 registration fee
  - Requires a Google account and a valid payment method
- **5 screenshots** (1280×800 or 640×400) of the extension in use
- **128×128 icon** (already generated in `extension/icons/icon128.png`)
- **Promo description** (132 chars short / 16,000 chars detailed) — Claude can draft

### Submission steps

1. Zip the `extension/` folder: `cd extension && zip -r ../soomqa.zip . -x "lib/config.js"`
2. Upload `soomqa.zip` in the Developer Dashboard → "New item"
3. Fill in store listing (description, screenshots, category: Productivity)
4. Submit for review. Google's review typically takes 1–7 days.

### What reviewers care about

- **Permissions justification** — we ask for `storage` (saves wallet list locally) and host permissions for blockchain APIs. Justify each in the form.
- **Privacy policy URL** — required if extension handles user data. We don't collect anything; a one-page "we don't collect anything" privacy policy on Cloudflare Pages is enough.
- **No paid features at launch is fine.** Pro tier ($9/mo via ExtensionPay) can be added in a 0.2 update once we have free users.

## Phase 3 — Monetization (Pro tier, ~1 week)

To be done after we have 50+ free users and a sense of which features they actually use:

1. Sign up at https://extensionpay.com (one-time $30 setup, no revenue share)
2. Create a product (Soomqa Pro, $9/month)
3. Integrate `extpay.js` into `popup.js` — gate "unlimited wallets" behind `extpay.getUser().paid`
4. Push 0.2 update to Chrome Web Store
