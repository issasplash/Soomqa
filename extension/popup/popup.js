import {
  getWallets,
  addWallet,
  removeWallet,
  isValidEvmAddress,
} from "../lib/storage.js";
import { getWalletSnapshot } from "../lib/api.js";
import { campaigns } from "../lib/campaigns.js";

const FREE_TIER_LIMIT = 3;

const els = {
  input: document.getElementById("address-input"),
  addBtn: document.getElementById("add-button"),
  addError: document.getElementById("add-error"),
  walletsList: document.getElementById("wallets-list"),
  walletsEmpty: document.getElementById("wallets-empty"),
  walletCount: document.getElementById("wallet-count"),
  resultsSection: document.getElementById("results-section"),
  resultsList: document.getElementById("results-list"),
  refreshBtn: document.getElementById("refresh-button"),
  upgradeLink: document.getElementById("upgrade-link"),
};

function shorten(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function showError(message) {
  els.addError.textContent = message;
  els.addError.classList.remove("hidden");
}

function clearError() {
  els.addError.textContent = "";
  els.addError.classList.add("hidden");
}

async function renderWallets() {
  const wallets = await getWallets();
  els.walletsList.innerHTML = "";
  els.walletCount.textContent = `${wallets.length} / ${FREE_TIER_LIMIT}`;

  if (wallets.length === 0) {
    els.walletsEmpty.classList.remove("hidden");
    els.resultsSection.classList.add("hidden");
    return;
  }

  els.walletsEmpty.classList.add("hidden");

  for (const address of wallets) {
    const li = document.createElement("li");
    li.className = "wallet-item";
    li.innerHTML = `
      <span class="address" title="${address}">${shorten(address)}</span>
      <button class="remove" data-address="${address}" title="Remove">×</button>
    `;
    els.walletsList.appendChild(li);
  }

  els.walletsList.querySelectorAll(".remove").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      await removeWallet(e.target.dataset.address);
      await renderWallets();
      await checkEligibility();
    });
  });
}

function renderCampaignResult(campaign, result, sampleAddress) {
  const div = document.createElement("div");
  div.className = "campaign";
  div.innerHTML = `
    <div class="campaign-header">
      <span class="campaign-name">${campaign.name}</span>
      <span class="badge ${result.status}">${labelFor(result.status)}</span>
    </div>
    <div class="campaign-meta">
      ${campaign.chain} · ${result.reason}
    </div>
  `;
  return div;
}

function labelFor(status) {
  if (status === "eligible") return "Eligible";
  if (status === "partial") return "Partial";
  return "Not yet";
}

async function checkEligibility() {
  const wallets = await getWallets();
  if (wallets.length === 0) {
    els.resultsSection.classList.add("hidden");
    return;
  }

  els.resultsSection.classList.remove("hidden");
  els.resultsList.innerHTML = '<p class="muted">Checking…</p>';

  // For MVP: aggregate across all wallets — show the best result per campaign.
  // (A farmer wants to know "do I have ANY wallet that qualifies" first.)
  const snapshots = await Promise.all(wallets.map(getWalletSnapshot));
  const aggregated = aggregateSnapshots(snapshots);

  els.resultsList.innerHTML = "";
  for (const campaign of campaigns) {
    const result = campaign.score(aggregated);
    els.resultsList.appendChild(renderCampaignResult(campaign, result));
  }
}

// Pick the strongest values per chain across all snapshots — captures
// "your farm taken together" rather than any single wallet in isolation.
function aggregateSnapshots(snapshots) {
  const merged = {};
  for (const snap of snapshots) {
    for (const [chain, data] of Object.entries(snap)) {
      if (!merged[chain]) {
        merged[chain] = { txCount: 0, balanceEth: 0, balanceWei: "0" };
      }
      merged[chain].txCount += data.txCount || 0;
      merged[chain].balanceEth += data.balanceEth || 0;
    }
  }
  return merged;
}

els.addBtn.addEventListener("click", async () => {
  clearError();
  const address = els.input.value.trim();

  if (!isValidEvmAddress(address)) {
    showError("Invalid EVM address. Expected 0x followed by 40 hex characters.");
    return;
  }

  const wallets = await getWallets();
  if (wallets.length >= FREE_TIER_LIMIT) {
    showError(`Free tier limit reached (${FREE_TIER_LIMIT}). Upgrade to Pro for unlimited.`);
    return;
  }

  await addWallet(address);
  els.input.value = "";
  await renderWallets();
  await checkEligibility();
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.addBtn.click();
});

els.refreshBtn.addEventListener("click", checkEligibility);

els.upgradeLink.addEventListener("click", (e) => {
  e.preventDefault();
  // ExtensionPay integration goes here in Phase 2.
  alert("Pro tier coming soon. For now, the free tier supports up to 3 wallets.");
});

renderWallets().then(checkEligibility);
