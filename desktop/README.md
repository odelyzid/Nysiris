# Desktop launcher (Linux)

Build the desktop delivery for Linux Mint / Debian / Ubuntu.

## Recommended: system-Chromium `.deb`

Small package, no bundled browser, uses the Chromium engine the Nym WASM client
targets.

```sh
./build.sh web          # produce web/dist (needs npm + network)
./build.sh desktop      # -> dist/fly-protocol_0.1.0_amd64.deb
sudo apt install ./dist/fly-protocol_0.1.0_amd64.deb
fly-protocol            # or launch from the application menu
```

What the package contains:

| Path | Purpose |
|---|---|
| `/usr/bin/fly-protocol` | wrapper that runs the launcher against the bundled web root |
| `/usr/lib/fly-protocol/fly-protocol-launcher` | dependency-free std-only static server + browser launcher |
| `/usr/lib/fly-protocol/web/` | the built PWA |
| `/usr/share/applications/fly-protocol.desktop` | menu entry |
| `/usr/share/icons/hicolor/scalable/apps/fly-protocol.svg` | icon |

The launcher binds **127.0.0.1 only**, sets `COOP`/`COEP` for cross-origin
isolation, refuses path traversal, and opens a Chromium `--app` window. It
prefers `chromium`, then `chromium-browser`, `google-chrome`,
`google-chrome-stable`, `brave-browser`, `microsoft-edge`, and finally falls
back to `xdg-open`.

## Running without packaging

```sh
cargo run -p fly-protocol-launcher -- --root web/dist
# serve only, no browser window (useful for tests):
cargo run -p fly-protocol-launcher -- --root web/dist --no-open --port 8737
```

The launcher runs the app in a **dedicated Chrome profile**
(`$XDG_DATA_HOME/fly-protocol/chrome-profile`) with `--disable-extensions`. That
matters: browser extensions (wallets, content blockers) can block the app's own
JavaScript (`ERR_BLOCKED_BY_CLIENT`, a silent blank window) and inject
`window.ethereum`/`window.web3`. Use `--profile DIR` to override and
`--allow-extensions` to opt out. See
[`docs/07-desktop-linux.md`](../../docs/07-desktop-linux.md) §7.10 for
troubleshooting.

## Alternative: Electron (self-contained)

Bundles Chromium, so it does not depend on a system browser, at the cost of
size (~150 MB installed). See `desktop/electron/`.

```sh
./build.sh desktop --electron --app-version 0.1.1
# or manually:
cd desktop/electron
npm install
mkdir -p web && cp -r ../../web/dist/* web/
npm run dist            # -> desktop/electron/dist/{*.deb, *.AppImage}
```

The `.deb` requires Debian maintainer metadata, which `package.json` provides
(`homepage`, `author.email`, `linux.maintainer`, and `build/icon.png`).

## Alternative: Chromium "Install PWA"

Zero packaging. Serve `web/dist` over HTTPS (or `localhost`) and use the
browser's *Install* action (Chrome/Chromium address bar) to create a desktop
entry. No `.deb` needed, but it depends on the user's browser and does not give
you a distributable artifact.

See [`docs/07-desktop-linux.md`](../../docs/07-desktop-linux.md) for the full
comparison, including Tauri/WebKitGTK caveats and Flatpak/AppImage notes.
