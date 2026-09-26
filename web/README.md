# nysiris web client

Cross-platform Nym mixnet client: runs in desktop browsers, Android browsers,
a Bubblewrap Trusted Web Activity, and a Capacitor Android shell.

## Install & run

```sh
npm install
npm run dev          # http://localhost:5173
npm run build        # type-check + production build to dist/
npm run preview
```

`@nymproject/mix-fetch` and `@nymproject/sdk-full-fat` inline their WASM and
worker as Base64, so there is **no bundler configuration**. If you prefer the
smaller `@nymproject/sdk`/`mix-tunnel` variants, follow Nym's bundling guide.

## What is here

| Module | Purpose |
|---|---|
| `src/mixnet/tunnel.ts` | Memoised one-shot `setupMixTunnel`, state, teardown |
| `src/mixnet/fetch.ts` | `mixFetch` wrapper + clearnet-vs-mixnet IP proof |
| `src/mixnet/messaging.ts` | Nym-address send + anonymous SURB reply |
| `src/mixnet/enforcement.mjs` | Reply dedupe/TTL, reply budget, privacy guardrail, exit policy |
| `src/mixnet/leakGuard.ts` | Blocks direct requests to routed hosts |

## Icons

`public/icons/` is generated (and committed). Regenerate with:

```sh
python3 ../scripts/gen-icons.py
```

The CSP lives in `index.html`. Note that `frame-ancestors` is ignored in a
`<meta>` CSP — it belongs in an HTTP response header (the desktop launcher
sends `X-Frame-Options: DENY`).
| `src/application/views.ts` | Primary views (Home/Messages/Portal/Settings), Advanced visibility, onboarding flag |
| `src/adapters/driving/shared/StatusPill.tsx` | Discreet protection pill with friendly details popover |
| `src/adapters/driving/shared/ShareCard.tsx` | Petname-first label, Copy link, local QR (`qrcode` → data URL, no network) |
| `src/shared/friendlyErrors.ts` | Raw-error → calm headline/help/action mapping |
| `src/adapters/driving/shared/theme.css` | Calm responsive theme (mobile-first, dark-mode aware) |
| `src/App.tsx` | React UI: view switching, URI-bar binding, panel composition |

## Android

### Trusted Web Activity (recommended)

```sh
npm run build
# deploy dist/ to HTTPS, then:
bubblewrap init --manifest https://your.app/manifest.webmanifest
bubblewrap build
```

You must also publish `/.well-known/assetlinks.json` for the app to open
without a URL bar. Placeholder icons are committed at
`public/icons/icon-192.png` and `public/icons/icon-512.png`; regenerate real
ones with `scripts/gen-icons.py` before shipping.

### Capacitor

```sh
npm run build
npx cap add android
npm run android:sync
npm run android:open      # Android Studio
```

See [`../android/README.md`](../android/README.md) for manifest, network
security config, background-execution limits, and secure-storage guidance.

## Scope and limits (read before promising anything)

* This client routes requests **made by this app**. It cannot transparently
  proxy the whole browser or the phone.
* Android Chrome does **not** support extensions; the `extension/` scaffold is
  desktop-only.
* For system-wide Android routing use **NymVPN**; for a desktop SOCKS proxy use
  `nym-socks5-client` on `127.0.0.1:1080`.
* Mixnet requests are slow (hundreds of ms to seconds) and metered; design UIs
  to be async.
