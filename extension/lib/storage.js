const KEY_WALLETS = "wallets";

export async function getWallets() {
  const result = await chrome.storage.local.get(KEY_WALLETS);
  return result[KEY_WALLETS] || [];
}

export async function addWallet(address) {
  const wallets = await getWallets();
  const normalized = address.toLowerCase();
  if (wallets.includes(normalized)) return wallets;
  const next = [...wallets, normalized];
  await chrome.storage.local.set({ [KEY_WALLETS]: next });
  return next;
}

export async function removeWallet(address) {
  const wallets = await getWallets();
  const next = wallets.filter((w) => w !== address.toLowerCase());
  await chrome.storage.local.set({ [KEY_WALLETS]: next });
  return next;
}

export function isValidEvmAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
