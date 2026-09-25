# Changelog

Format follows Keep-a-Changelog (loosely); versions are `VERSION`-driven
(`./build.sh bump <version>`). Pre-1.0: anything may change.

## [Unreleased]

### Added

- README: featured hidden services with copy-paste `nym://` addresses
  (TribeWarez Portal, Hidden Wiki) and a sandbox/no-endorsement note.

## [0.1.27] — 2026-09-25

### Added

- Hosting SDK: `crates/nysiris-sdk/` (workspace member, nym-free) — `HostConfig`
  (storage/gateway/address-file convention), a transport-generic `serve()`
  harness over the provider-runtime loop, and a traversal-safe `StaticFiles`
  hidden service. Curated re-exports + `prelude`, so a service author adds one
  dependency. 11 tests; stays in the fast `./build.sh check` loop.
- `nysiris` hosting CLI: `services/nysiris-cli/` (standalone, `nym-sdk`) with
  `host echo|files`, `address`, `fetch`, `petname add|list|remove|resolve`, and
  `doctor`. Carries the single `MixnetRuntime` adapter over `MixnetClient`
  (replacing the per-provider glue); dependency-free, unit-tested parser.
- `PetnameRegistry::iter`, so host tooling can list the local-only registry.
- Docs: `docs/13-sdk-cli.md`; README/AGENTS/services cross-links; the new crate
  is wired into the workspace, the service-pin check, and `./build.sh services`.

## [0.1.26] — 2026-09-25

### Added

- Encrypted attachments for posts and DMs: browser-encrypted files
  (XChaCha20-Poly1305, content-addressed `SHA256(blob)` ids), ≤256 KiB and
  ≤3 per message, 7 whitelisted MIME types. Provider stores opaque blobs
  via chunked `POST /blob/part` upload (44 KiB/envelope, per-part PoW) and
  `GET /blob/<id>`; attachment refs ride the post signature and the v2 DM
  inner envelope. Composer paperclip picker with chips, blurred-until-click
  thumbnails, download cards, "Attachment unavailable" fallback.
  (`services/social/src/attach.rs`, `web/src/domain/attachments.mjs`,
  `web/src/domain/attachmentCrypto.ts`,
  `web/src/adapters/driving/social/attachmentUi.tsx`, docs §9.5b; 24 service tests, 191 web tests.)
- Parallel blob-part upload (concurrency 3) via echoed correlation tags
  (`Request`/`Response.tag`, `fetchNymParallel` with sequential fallback for
  pre-tag providers).
- **Experimental / pre-audit disclaimer** in `README.md`: no independent
  audit yet, reference crypto only.
- Keystore-backed social identity on Android: `NysirisKeystore` Capacitor
  plugin (AES-256-GCM keys in the hardware-backed Android Keystore,
  ciphertext-only in SharedPreferences) with a dependency-free JS contract
  (`web/src/adapters/driven/keystore.mjs`), secure load/persist/migrate helpers in
  `identity.ts`, and `web/test/keystore.test.mjs`.
- Exit-rotation reconnect jitter (±10 around the 50-request bound,
  `fetch.ts`) so rotation timing is not itself a signal (§5.2.3).
- Adversarial chaos harness for the browser enforcement controls
  (`web/test/chaos-enforcement.test.mjs`): replay storms, SURB hoarding
  bursts, interleaved duplicates, clock skew, budget floods, and a
  randomised model-checked sequence.
- Service drift guards: `scripts/check-service-pins.mjs` (runs in
  `./build.sh check`; fails on `nym-sdk` req/lock divergence) and a Monday
  nightly `./build.sh services` workflow.
- Fixed `android:allowBackup` contradiction (generated manifest said `true`,
  docs and reference manifest said `false`): backups disabled so WebView /
  app data never lands in cloud backup.
- Community UI polish (frontend only): progressive-disclosure identity bar
  (short ID + invite action, full controls behind a toggle), stronger tab
  states, calmer button hierarchy (one primary action per context),
  chat-style DM composer with growing input, unified empty states, roomier
  timeline spacing. No logic or protocol changes.
- Orange pixel-bevel theme (was teal): square corners, raised-bevel buttons,
  sunken-bevel inputs, AA-verified accent pairs.
- Electron window association: top-level `desktopName` + `syncDesktopName`
  so the `.desktop` entry carries `StartupWMClass=nysiris`.
- Build scripts resolve the repo root through symlinks (`build.sh`,
  `run-provider.sh`, `build-deb.sh`), so relocated folders and linked
  entry points keep working.
- On-device keystore smoke test (`KeystoreCryptoDeviceTest`, 2/2 green on
  an API-34 emulator): real Android Keystore round-trip, ciphertext-only
  storage assertion, tamper rejection; plus host-JVM framing tests
  (`KeystoreCryptoTest`, 5/5).
- Project website at [nysiris.tribewarez.com](https://nysiris.tribewarez.com/)
  and a **GitHub Wiki** mirror of `docs/` + README, republished automatically
  when docs change (`scripts/publish-wiki.mjs`, `.github/workflows/wiki.yml`).
- README screenshots for the Home / Messages / Portal tabs plus a preview card
  (`docs/images/`).

### Changed

- Reorganized `web/src` by separation of concerns: `domain/` (pure rules),
  `application/` (orchestration), `adapters/driving|driven/`, `shared/`.
- Split the ~1,900-line `Social.tsx` into concern hooks and small presentational
  components; it is now a thin orchestrator.
- Community files moved: `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `CHANGELOG.md` → `.github/`; `AGENTS.md` → `.agents/AGENTS.md`.

### Fixed

- Doc path references after the `web/src` reorg; invalid GitHub funding key
  (`kofi` → `ko_fi`).

## [0.1.18] — 2026-09-21

### Changed

- Renamed `fly-protocol` to **Nysiris** (binaries, packages, install paths,
  UI, docs). Frozen for compat: `fly-*` CSS classes, `fly.*` localStorage
  keys, `fly-social-v1/*` / `fly-portal-v1/*` signature domains.

### Added

- Windows support: Edge/Chrome auto-detect in the launcher, `%LOCALAPPDATA%`
  profile dir, `Nysiris.bat` zip packaging (`./build.sh windows`), `docs/12-windows.md`.
- GitHub release workflow: `v*` tags build the Linux `.deb` + Windows zip
  with `SHA256SUMS.txt` (`.github/workflows/release.yml`).
- Encrypted identity backup (argon2id + XChaCha), QR-code scanning for IDs
  and links (built-in `BarcodeDetector`), petname collision warnings.
- Trust gating (blocked collapse, watch cautions, trusted-only filter) and
  signed invite vouches with one-tap trust.
- Thread deep-links (`#thread=<id>`) with a per-id gap-fetch budget.

### Fixed

- DM conversation list: signed inner envelope attributes senders, unread
  badges, local history cache (dead-drop reads are destructive).
- `check` covers service manifests; `clean` removes service build outputs;
  `services` command builds locked + tests per crate with an optional filter.

## [0.1.0] — 2026-09-19 (first public baseline)

- Reference Sphinx core + enforcement controls (60 Rust tests).
- Browser PWA: mix-tunnel, leak guard, Nym-address messaging, `fetchNym`.
- Services: echo-provider, hybrid-bridge, portal-provider, nysiris-social,
  acceptance harness (live mainnet delivery + SURB reply verified).
- Linux `.deb` + Electron desktop shells, Android (TWA/Capacitor) scaffolds.
- Security analysis (`docs/05-security.md`) with controls enforced in code.
