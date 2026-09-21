# Extension scaffold (desktop only)

An MV3 extension is a **desktop convenience**, not the Android path: Chrome for
Android does not support extensions. The cross-platform client is the PWA in
`web/`.

## Load it

1. Bundle the Nym packages first (the extension context cannot resolve bare npm
   imports). The simplest approach is to reuse the `web/` build and add the
   extension entry points, or run esbuild over `background.js`/`offscreen.js`.
2. Load unpacked at `chrome://extensions` (enable Developer mode).

## Architecture caveat

An MV3 service worker is suspended when idle. The mixnet tunnel is long-lived
and one-shot, so it must run in an **offscreen document**
(`chrome.offscreen.createDocument`) or a dedicated extension page. `background.js`
only stores configuration and coordinates; it does not own the tunnel.

## What it can and cannot do

* Can: route requests your extension code controls, and detect direct requests
  to allow-listed hosts.
* Cannot: transparently proxy every tab's network stack. `declarativeNetRequest`
  can redirect, not reroute through WASM. For system-wide routing use a local
  `nym-socks5-client` plus the browser's proxy settings (desktop), or NymVPN
  (all platforms).
