// MV3 service worker. Event-driven; Chrome will spin it up on demand.
//
// Currently a placeholder for future features:
//   - Periodic background eligibility checks (chrome.alarms)
//   - Push notifications when status changes ("you became eligible for X")
//   - Cache layer to avoid re-fetching the same wallet snapshot within N minutes

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    // First-time install. Could open an onboarding page here later.
    console.log("[Soomqa] Installed");
  }
});
