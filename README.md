# fly-protocol

Design and implementation for **routing traffic through the Nym mixnet with
Sphinx packets**: a cross-platform browser client (web / PWA / Android) and
several ways to host a service on the mixnet.

> **Status:** foundations, hosting, browser client, social/DMs, trust
> indicators, desktop packaging, and security analysis complete, with the
> documented controls enforced in code and tests.
> * Reference Sphinx core + enforcement controls: **60 Rust tests pass**.
> * Browser PWA + social logic: **111 `node --test` tests pass**.
> * Service hosting: runnable providers + hybrid compose + gateway assets.
> * Build system: `./build.sh` for Rust / web / Android / services / desktop /
>   Windows / check, plus CI.
> * The `services/*` builds depend on Nym's own packages and are not compiled by
>   the fast `./build.sh check` loop.

## Read in this order

1. [`docs/01-architecture.md`](docs/01-architecture.md) — system overview, two
   traffic modes, trust boundaries, browser/WASM constraints.2. [`docs/02-addressing-and-routing.md`](docs/02-addressing-and-routing.md) —
   how "DNS" is replaced by cryptographic identities, the exact Sphinx
   construction (`alpha`, `beta`, `gamma`, `delta`), SURBs, diagrams.
3. [`docs/04-hosting-services.md`](docs/04-hosting-services.md) — pure mixnet
   provider, hybrid clearnet+mixnet, self-hosted gateway, with configs.
4. [`docs/03-browser-client.md`](docs/03-browser-client.md) — cross-platform
   client design, leak guard, CSP, Android packaging.
5. [`docs/05-security.md`](docs/05-security.md) — threat model (L1/L2/L3L/L3G,
   V1/V2/V3, P1/P2), tagging, timing, SURB hoarding/reuse, exit trust.
6. [`docs/08-hidden-services.md`](docs/08-hidden-services.md) — hidden-service
   abstraction: `nym://` URIs, envelopes, server dispatch, petnames, chunking.
7. [`docs/09-social.md`](docs/09-social.md) — fly-social: metadata-minimal
   microblog + E2E DMs, SQLite security, signature/E2E specs, operations.
8. [`docs/07-desktop-linux.md`](docs/07-desktop-linux.md) — Linux Mint / Debian
   desktop packaging (`.deb`, Electron, Tauri, Flatpak) and engine compatibility.
9. [`docs/06-roadmap.md`](docs/06-roadmap.md) — phased plan with acceptance
   criteria.

## Build & verify

One entry point for everything:

```bash
./build.sh check              # fmt + clippy(-D warnings) + all tests + docs
./build.sh rust --release     # optimized workspace build
./build.sh rust --target aarch64-unknown-linux-gnu
./build.sh wasm               # sphinx-core -> wasm32 (optional)
./build.sh web                # install deps + build the PWA
./build.sh android            # TWA (Bubblewrap) or Capacitor
./build.sh services           # standalone Nym service crates
./build.sh soak               # heavy parser/route soak (release)
./build.sh acceptance         # live-network delivery + SURB reply (needs Nym toolchain)
./build.sh desktop            # Linux .deb (system Chromium); --electron for Electron
./build.sh windows            # Windows zip via MSYS2/MinGW or MSVC (see docs/12-windows.md)
./build.sh all                # rust + check + web
./build.sh clean [--deep]
./build.sh --help
```

Releases are cut from tags: `./build.sh bump <version>`, commit `VERSION`,
`git push origin v<version>` — CI builds the `.deb` + Windows zip and
publishes them with checksums (`.github/workflows/release.yml`).
```

`./build.sh check` runs **61 Rust tests** and **111 web unit tests** with zero
clippy warnings, validates the JSON manifests, and checks every relative link in
the docs. It runs offline (no `npm install`). CI runs it on every push/PR.

- **Fuzzing**: deterministic mutation fuzzing runs inside `check`; optional
  coverage-guided fuzzing is in `crates/sphinx-core/fuzz/` (nightly + cargo-fuzz).
- **Soak**: `./build.sh soak` runs 5,000 randomised routes/messages in release.
- **Live network**: `./build.sh acceptance` sends to self and replies over SURBs
  against mainnet. See `services/acceptance/README.md` for toolchain setup.

## Releasing / versioning

`./VERSION` is the single source of truth for the application version. It drives
the `.deb` and Electron packages and is kept in sync with `web/package.json`
and `desktop/electron/package.json`.

```bash
./build.sh bump patch        # 0.1.6 -> 0.1.7
./build.sh bump minor        # 0.1.6 -> 0.2.0
./build.sh bump major        # 0.1.6 -> 1.0.0
./build.sh bump 1.2.3        # set an explicit version

./build.sh desktop                       # -> dist/fly-protocol_<version>_amd64.deb
./build.sh desktop --electron            # -> Electron .deb + AppImage
./build.sh web && ./build.sh android     # PWA / Android
./build.sh check                         # verify
```

`--app-version X.Y.Z` overrides the version for one build without changing
`./VERSION`.

> The Rust crates under `crates/` carry their own independent versions
> (`0.1.0`); `./VERSION` is the **application / package** version.

## Upgrading dependencies

| Component | Where | How |
|---|---|---|
| Rust toolchain | system | `rustup update` |
| Rust crates | `crates/*/Cargo.toml` | edit the version, then `cargo update` |
| Nym SDK (services) | `services/*/Cargo.toml` | `cargo search nym-sdk`, raise the version, rebuild |
| Browser Nym SDK | `web/package.json` | `npm view @nymproject/mix-fetch version` (and `sdk-full-fat`), then `npm install` |
| Electron | `desktop/electron/package.json` | `npm install electron@latest electron-builder@latest --save-dev` |

`nym-sdk`, `nym-bin-common` and `nym-sphinx` are versioned **independently** on
crates.io (as of this writing `nym-sdk` 1.21.6 while `nym-bin-common` is
1.22.0), so raise them individually and re-read the API when you do — the
messaging API has changed between releases.

After any upgrade: `./build.sh check`, then `./build.sh acceptance` for anything
touching the network path.

## What is implemented

| Path | What | Verification |
|---|---|---|
| `crates/sphinx-core/` | Reference Sphinx: header/blinding/filler/MAC/Lioness/SURB/address | `cargo test -p sphinx-core` |
| `crates/sphinx-core/src/enforcement.rs` | Route policy, SURB single-use/expiry, reply budget, exit rotation, cover-traffic guardrail | 12 tests |
| `crates/bridge-guard/` | Open-proxy guards for the mixnet↔HTTP bridge | 8 tests |
| `crates/nym-hidden-service/` | Hidden-service abstraction: URIs, envelopes, dispatch, petnames, chunking | 7 tests |
| `crates/portal-data/` | Portal data model: content-addressed objects, append-only logs, LWW-map | 4 tests |
| `crates/portal-replication/` | Sync core: heads, want-lists, verified atomic apply | 4 tests |
| `crates/portal-reputation/` | PoW, local reputation scores, provider rate limits | 5 tests |
| `crates/sphinx-core/tests/fuzz_parser.rs` | Deterministic mutation fuzzing of all parsers | 6 tests |
| `crates/sphinx-core/tests/soak.rs` | Randomised route/message soak (release) | `./build.sh soak` |
| `crates/sphinx-core/fuzz/` | Coverage-guided fuzzing targets (nightly) | `cargo +nightly fuzz run parse_packet` |
| `services/echo-provider/` | Pure-mixnet service provider (`nym-sdk` 1.21.x messaging) | Written against documented API; build in place |
| `services/acceptance/` | Live-network delivery + SURB reply harness | **Passed on mainnet**: delivery ≈7.6 s, SURB reply ≈7.1 s |
| `services/hybrid-bridge/` | Nym↔HTTP bridge + Caddy + Docker Compose, using `bridge-guard` | `docker compose config` + guard tests |
| `services/social/` | fly-social: signed-post microblog + E2E DM dead-drop (SQLite, `HiddenService`); PoW + rate-limit hooks (`SOCIAL_POW_BITS`, `SOCIAL_RATE_PER_DAY`) | 9 tests + `web/src/social/` timeline UI |
| `services/portal-provider/` | Portal object/log store; PoW + rate-limit hooks (`PORTAL_POW_BITS`, `PORTAL_RATE_PER_DAY`) | 5 tests |
| `services/portal-provider/` | Portal object/log store (data + verification only) | 4 tests |
| `services/gateway/` | `nym-node` entry-gateway config, systemd, bonding notes | Templates + operator steps |
| `web/` | React PWA: tunnel, `mixFetch`, Nym-address messaging, `fetchNym`, fly-social timeline, leak guard, runtime enforcement | 45 `node --test` tests + `npm run build` |
| `android/` | TWA/Capacitor guidance, manifest, network security config | Templates |
| `desktop/launcher/` | std-only Linux launcher: loopback static server + Chromium app window | 5 tests |
| `desktop/debian/` | `.deb` packaging (control, postinst, `.desktop`, icon) | Built + inspected; `./build.sh desktop` |
| `desktop/electron/` | Electron alternative (bundled Chromium) | Scaffold |
| `extension/` | MV3 desktop scaffold | Load unpacked after bundling |
| `build.sh` + `scripts/` | Rust / web / android / services / check build system | `check` runs offline |
| `.github/workflows/ci.yml` | CI | Runs `./build.sh check` |

## Reference core

`crates/sphinx-core` is a faithful, tested mirror of Nym's `sphinx-packet`:

* X25519 key schedule + per-hop blinding, HKDF-SHA256 → 288 bytes
* AES-128-CTR header onion with the Sphinx filler
* HMAC-SHA256 (16-byte) header integrity
* Lioness (BLAKE2b + ChaCha) payload onion
* SURBs, Nym address parsing (`<id>.<enc>@<gw>`), path selection

```bash
./build.sh check
```

It produces a **regular packet of exactly 2413 bytes** (348 header + 2065
payload), matching the production network.

> ⚠️ **Not production crypto.** Real software must use Nym's audited packages:
> `@nymproject/mix-tunnel` / `mixFetch` / `sdk-full-fat` (browser),
> `nym-sdk` / `nym-sphinx` / `sphinx-packet` (Rust), `nym-client` /
> `nym-socks5-client` (standalone). This crate is for education, audit and test
> vectors.

## Layout

```
build.sh                 one entry point: rust | web | android | services | check | all | clean
scripts/                 modular build commands + doc/JSON validators
.github/workflows/       CI runs ./build.sh check
crates/sphinx-core/      reference Sphinx + enforcement controls (workspace)
crates/bridge-guard/     open-proxy guards (workspace)
crates/nym-hidden-service/  hidden-service abstraction: URIs, envelopes, dispatch, petnames (workspace)
docs/                    architecture, addressing/routing, hosting, client, security, desktop, hidden-services, roadmap
services/                echo-provider, hybrid-bridge, gateway (standalone crates)
web/                     React PWA client (TypeScript)
android/                 Android packaging manifest + guidance
desktop/                 Linux desktop: launcher, .deb packaging, Electron alternative
extension/               MV3 desktop scaffold
```
