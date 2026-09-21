# Changelog

Format follows Keep-a-Changelog (loosely); versions are `VERSION`-driven
(`./build.sh bump <version>`). Pre-1.0: anything may change.

## [Unreleased]

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
