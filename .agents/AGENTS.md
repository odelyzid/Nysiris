# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

`nysiris` routes traffic through the **Nym mixnet** using the **Sphinx
packet format**: a React + Vite browser PWA (`web/`), community/DM services
over the mixnet (`services/`), a Linux desktop shell (`desktop/`), and a
reference Sphinx implementation (`crates/sphinx-core`). Live-network delivery
+ SURB reply is verified on mainnet via `./build.sh acceptance`.

## Golden rules

1. **Never present `crates/sphinx-core` as production-ready.** Reference and
   test vectors only. Real code must use Nym's audited packages:
   - Browser: `@nymproject/mix-tunnel`, `@nymproject/mix-fetch`,
     `@nymproject/sdk-full-fat`.
   - Rust: `nym-sdk`, `nym-sphinx`, `sphinx-packet`.
2. **Be exact about the wire format** (do not change): `SECURITY_PARAMETER =
   16`, `MAX_PATH_LENGTH = 5`, header `348 B` (alpha 32 + gamma 16 + beta
   300), payload buffer `2065 B`, regular packet `2413 B`. Header onion is
   AES-128-CTR with zero IV; MAC is HMAC-SHA256 truncated to 16 B; payload is
   Lioness (BLAKE2b + ChaCha); HKDF-SHA256 expands the X25519 secret to 288 B
   as `stream_key(16) | mac_key(16) | payload_key(192) | blinding(32) |
   replay_tag(32)`.
3. **Terminology.** Entry Gateway, Mix Node, Exit Gateway, Service Provider,
   Network Requester, IP Packet Router, SURB, NetDB/topology, epoch. Nym
   addresses are `<identity>.<encryption>@<gateway>`; resolution is out of
   band. Do not say "Nym DNS" or invent a directory/resolver.
4. **Security vocabulary** (`docs/05-security.md`): actors **L1/L2/L3L/L3G**,
   vectors **V1/V2/V3**, properties **P1/P2**, two-layer model. Never claim
   mixing protects against the destination (L2).

## Layout

- Rust 2021 workspace at root. Members: `crates/sphinx-core`,
  `crates/bridge-guard`, `crates/nym-hidden-service`, `crates/nysiris-sdk`,
  `crates/portal-data`, `crates/portal-replication`, `crates/portal-reputation`,
  `crates/provider-runtime`, `crates/social-format`, `desktop/launcher`.
  Everything else with a `Cargo.toml` is standalone.
- `services/`: `echo-provider`, `hybrid-bridge`, `portal-provider`, `social`,
  `acceptance`, `nysiris-cli` (each with its own `Cargo.lock`; `gateway/` is
  ops-only: no crate, just systemd + example config). Excluded from the
  workspace because of the heavy `nym-sdk` toolchain — never add them to
  `workspace.members`. `nysiris-cli` also depends on the workspace-member
  `crates/nysiris-sdk` by path; keep the SDK nym-free so `check` stays fast.
- `web/`: React PWA (`src/`), `test/` (node unit tests), `android/`,
  `extension/` (MV3, desktop-only). `docs/` is numbered `01–12` by
  deliverable. `scripts/cmd-*.sh` implement `./build.sh` subcommands.
- Naming: the product is **Nysiris** (`nysiris-*` packages, binaries,
  install paths). These historical identifiers are frozen for compat — do
  not "fix" them: `fly-*` CSS classes, `fly.*` localStorage keys (identity
  and contacts live there; renaming loses user data), and the
  `fly-social-v1/*` / `fly-portal-v1/*` signature domains (renaming
  invalidates existing signed posts, invites, and DMs), and the
  `fly.portal.sync.v1` localStorage key (the read-side portal replica lives
  there; renaming silently drops synced history).

## Verify

```bash
./build.sh check            # fmt + clippy(-D warnings) + cargo test + node tests + JSON/docs + service manifests
./build.sh rust             # workspace build (add --release / --target TRIPLE / --skip-tests)
./build.sh services [name]  # --locked --release build + cargo test per service crate (heavy; --skip-tests available)
./build.sh web              # browser PWA build
./build.sh desktop           # Linux .deb (system Chromium)
./build.sh windows           # Windows zip (MSYS2/MinGW or MSVC; docs/12-windows.md)
./build.sh acceptance       # live-network delivery + SURB reply (needs toolchain + internet)
```

Releases are cut from `v*` tags (CI builds `.deb` + Windows zip with
checksums). `VERSION` is the source of truth; bump with
`./build.sh bump <version>`.

- Current counts: 111 Rust tests, 200 web tests, zero clippy warnings.
- Focused runs: `node --test web/test/<name>.test.mjs` (from repo root),
  `cargo test -p <crate>`, `./build.sh services social`.
- CI (`check` job) runs `./build.sh check` on Node 24; `web-build`/`android`
  are best-effort (`continue-on-error`).
- `check` only parses service manifests (fast/offline). First `services`
  build compiles `nym-sdk` from scratch (minutes); `clean` deletes
  `services/*/target` (gigabytes) — that cache is what keeps rebuilds fast.

## Web gotchas (all verified, all will bite)

- Run `npx tsc --noEmit` from `web/`, never root (root resolves a rogue
  `tsc` package instead of the project's TypeScript).
- Tests import `.ts` directly via Node type-stripping (CI pins Node 24).
  Tests needing `@noble/*` must use the dynamic-import skip pattern (see
  `web/test/dm-crypto.test.mjs`) so offline `check` passes without
  `node_modules`. Any **src** module inside a test's import chain must use
  explicit `.ts`/`.mjs` extensions on relative imports (`../lib/bytes.ts`) —
  an extensionless one makes the import fail and the test silently *skips*
  even with `node_modules` present (this hid 14 tests — see the CHANGELOG).
- Pure logic lives in dependency-free `web/src/**/*.ts|.mjs` with a
  `web/test/*.test.mjs` in the same change. `withVerdict`/`withPetname`-style
  helpers always copy — never rely on reference equality.
- Styling: `fly-btn` for buttons, `fly-input` for text inputs. Exceptions are
  contextual selectors, not omissions: `.fly-conv-list button`, `.fly-nav-btn`,
  `.fly-status`, `.fly-tab`. Never put `fly-btn` on conversation-list rows.
- `sdk-full-fat` 1.x surfaces **no `senderTag` and no reply API**. Browser
  messaging must use `rawSend` for Rust providers (a mime envelope breaks
  their `serde_json` parse). These console lines are expected noise, not bugs:
  `__wbg_init: using deprecated parameters`, `Failed to parse binary message`
  (worker emits `RawMessageReceived` first, then fails its mime attempt),
  `Client has not been initialised` (a `selfAddress` miss before connect).
- DM stack, in order: sealed box (`application/dm.ts` seal/open) → signed inner
  envelope (`packDmInner`/`unpackDmInner`, attribution for the recipient,
  opaque to the provider) → conversation cache (`application/conversations.ts`).
  Dead-drop reads are **destructive**: the local cache is the history, and
  only one device wins. Legacy plaintext DMs (no envelope) render under an
  `unknown` peer.
- Trust verdicts are owned by `App` (`trustMap`/`onVerdict`), shared by the
  timeline and the invite banner. Invite `vouches` (≤8, signed) fail closed
  when stripped. `decodeInviteCompact` **rebuilds** the invite object — new
  fields must be threaded through its return value or they are silently
  dropped.

## Services gotchas

- Build from the service dir or via `./build.sh services`; always
  `--locked` (lockfiles are committed). `nym-sdk` 1.21 messaging API:
  `wait_for_messages` / `send_reply`.
- `POST /dm` is sender-anonymous with no `in_reply_to`; `GET /dm` deletes on
  read and enforces TTL only on write. `MAX_DM_BYTES = 1800` on ciphertext —
  the web client checks this before proving PoW.
- When you add a documented control, add the code and its test in the same
  change; enforcement controls are named after their `docs/05-security.md`
  section. Docs use Mermaid for flows, ASCII for byte layouts.
