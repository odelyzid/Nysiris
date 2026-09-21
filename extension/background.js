/**
 * MV3 extension scaffold (DESKTOP ONLY — Chrome for Android has no extensions).
 *
 * Important architecture note
 * ---------------------------
 * An MV3 background *service worker* is ephemeral: Chrome suspends it when idle.
 * The Nym mixnet tunnel is long-lived and one-shot, so it must NOT live here.
 * Run it in an **offscreen document** (chrome.offscreen) or a dedicated
 * extension page, and have this service worker coordinate:
 *
 *   background.js  --chrome.runtime messages-->  offscreen.html (owns tunnel)
 *
 * This file therefore only stores configuration and handles the popup's
 * messages. Bundle the Nym packages (Vite/esbuild) before loading the extension;
 * raw npm imports will not resolve in the extension context.
 */

const DEFAULT_HOSTS = ['example.com'];

async function getConfig() {
  const { routedHosts = DEFAULT_HOSTS, failClosed = false } =
    await chrome.storage.local.get(['routedHosts', 'failClosed']);
  return { routedHosts, failClosed };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'get-config') {
    getConfig().then(sendResponse);
    return true; // async response
  }

  if (message?.type === 'set-config') {
    chrome.storage.local
      .set({ routedHosts: message.routedHosts, failClosed: message.failClosed })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

void (async () => {
  const { routedHosts } = await getConfig();
  console.info('[fly-protocol] routed hosts:', routedHosts.join(', '));
  // TODO: ensure the offscreen document that owns the tunnel is alive:
  //   await chrome.offscreen.createDocument({ url: 'offscreen.html', ... });
})();
