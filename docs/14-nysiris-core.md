# 14. Nysiris-Core: extracted protocol & transport

> **Status: partial extraction, shared DM wire contract.** The native chat
> protocol and the Nym transport seam live in
> [`TribeWarez/nysiris-core`](https://github.com/TribeWarez/nysiris-core),
> vendored here as the `core/` submodule (pinned `v0.2.0`, commit `990fdff`) and
> published on crates.io through the `0.1.x` line. `0.2.0` is the breaking
> release whose DM bytes match this browser client exactly. The browser client,
> the social provider, the hosting abstractions and the reference Sphinx
> implementation are still in this repository. This page records what moved,
> what did not, how to consume it, and the rules that keep the two repositories
> from drifting.

---

## 14.1 Why extract

The protocol and transport layer had three consumers with incompatible tech
stacks:

* the **browser PWA** (`web/`), TypeScript over `@nymproject/*`;
* the **Nysiris services** (`services/`), Rust over `nym-sdk`;
* **NCC** (Nysiris Chat Commander, PySide6 + `ncc-daemon`), a native client.

Duplicating identity, DM framing, history encryption and the transport adapter
in each consumer is how wire formats silently diverge. `nysiris-core` is the
middle of the dependency graph: primitives that are UI-agnostic, Nym-free where
possible, and reusable by every Nysiris-native target.

```
Nysiris browser PWA ──wire──► Nysiris services ──┐
                                                 ├──► Nysiris-Core
NCC (PySide6 + ncc-daemon) ──────────────────────┘
```

[NCC](https://github.com/TribeWarez/ncc) is the native consumer of the
chat/transport/history crates and the reference for a third-party client.

Two hard boundaries:

* `nysiris-core` **must not** depend on Nysiris or NCC.
* `Nysiris` **must not** depend on `nysiris-chat-core`; NCC **must not** depend
  on Nysiris. Consumers pin a tag and verify across repositories in CI.

---

## 14.2 What lives in `core/`

| Crate | Responsibility |
|---|---|
| `nysiris-core` | `ChatIdentity`, contacts, message types, signed DM inner envelope, sealed DM crypto, sealed files, the `Transport` trait |
| `nysiris-chat-history` | encrypted append-only flat-file history; one journal per conversation, no SQLite |
| `nysiris-chat-core` | 1:1 chat engine plus capability-key rooms with client-side fan-out |
| `nysiris-transport-nym` | `nym-sdk` adapter behind the `nym` feature; default builds use an explicit unavailable stub |
| `nysiris-testkit` | in-memory transport and fixtures for consumer tests |

The submodule is **not** a member of this Cargo workspace. Reasons:

* `nysiris-transport-nym` pulls the heavy `nym-sdk` toolchain; `./build.sh
  check` must stay fast and offline.
* The crates version and publish independently (crates.io versions are
  immutable, so a release is cut by tagging the workspace version; `0.1.2` was
  the first published set, `0.1.3` adds per-crate READMEs and complete rustdoc,
  `0.1.4` hardens sealed storage and inbound sender checks, and `0.2.0` aligns
  the DM wire format here).
* CI here validates the extraction as a consumer would — by checking out the
  pinned submodule, verifying the shared vectors have not drifted, and building
  it against its own lockfile, not by merging dependency graphs.

---

## 14.3 What stays in this repository

| Component | Why it has not moved |
|---|---|
| `crates/sphinx-core` | Reference Sphinx implementation and test vectors. Educational; keeps the 2413-byte packet geometry and enforcement controls next to the docs. |
| `crates/social-format` + `services/social` | Social wire format and provider. `nysiris-social-protocol` is planned in core but the service code is still coupled to the provider here. |
| `crates/nym-hidden-service`, `crates/provider-runtime`, `crates/nysiris-sdk` | Hosting abstractions (`HiddenService`, request loop, PoW/rate guards, `serve`). They consume service crates that have not been extracted (`nysiris-service` is planned). |
| `services/nysiris-cli`, `services/portal-provider`, `services/hybrid-bridge` | Standalone service binaries; designed to link the extracted crates once they exist. |
| `web/**` | The browser stack is TypeScript and uses `@nymproject/*`. Consuming the Rust chat crates requires a wasm build plus a JS binding layer; until then the PWA keeps its own DM/envelope implementation. |

The protocol therefore has two implementations at the moment of writing:

* **`core/` (Rust)** — native clients and, later, the Rust services;
* **`web/src/application/dm.ts` + `web/src/mixnet/` (TypeScript)** — the
  browser client.

They are byte-compatible as of `v0.2.0`: the DM construction and envelope fields
below are the contract, and a change on one side needs a change on the other.
The contract is pinned by a single fixture,
`core/crates/nysiris-core/tests/fixtures/dm-v2.json`, copied verbatim to
`web/test/fixtures/nysiris-core-dm-v2.json`. The core crate verifies it in its
own test suite; this repository's `core-submodule` CI job checks out the pinned
revision, runs that suite, and refuses a byte-level drift between the two
copies. `web/test/coreConformance.test.mjs` independently re-derives every
vector with the browser's noble-backed crypto.

---

## 14.4 Wire & crypto invariants

Do not change these without versioning the domain and updating both
implementations:

* **Identity**: ed25519 keypair; the public key converts to X25519 for DH.
* **Sealed DM**: ephemeral X25519 → `BLAKE2b-256` KDF (`fly-social-v1/dm`) →
  `XChaCha20-Poly1305`; the wire envelope is exactly
  `{epubHex, nonceHex, ciphertextB64}` — lowercase hex keys/nonce, padded base64
  ciphertext, no `v` field and no AEAD associated data.
* **Inner envelope**: JSON `{v, from, ts, msgId, bodyB64, atts?, sig}`, signed
  over `fly-social-v1/dm-inner || from(32) || ts_be64 || msgId(16) || body ||
  canonical_atts`. Version 2 adds attachment refs; a version 1 envelope with no
  attachments verifies identically. There is no `to` field: recipient binding
  comes from the sealed box, so the recipient can still attribute the DM while
  the provider cannot read it.
* **History**: each record is a sealed blob; the hashed conversation filename
  is bound as AEAD associated data, so records cannot be replayed into another
  conversation.
* **Rooms**: a random capability key is shared in a signed invite; the sender
  seals once and fans out to at most 16 members. There is no relay roster;
  removing a member means a new room key.
* **Domains**: DMs deliberately share the browser's `fly-social-v1/dm` and
  `fly-social-v1/dm-inner` domains — that is the point of the alignment. Rooms
  keep the NCC-local `nysiris-chat-v1/*` domains. Never copy provider routes.
* **Transport** is a trait: `send(recipient, payload)`. The core never opens a
  socket; `nysiris-transport-nym` does, via `nym-sdk`.

Security caveat: `core/` is a protocol implementation, not audited
cryptography. `sealed_file` still uses a simple overwrite — add atomic rename +
fsync before production use.

---

## 14.5 Submodule workflow

Initialise (the `--recurse-submodules` clone in the README does this for you):

```bash
git submodule update --init --recursive
git submodule status          # 990fdff... — tagged v0.2.0
```

Verify the extracted workspace (always `--locked`: the lockfile is what makes
the Nym tree buildable):

```bash
cd core
cargo fmt --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo doc --workspace --no-deps --locked
bash scripts/check-nym-pins.sh                        # from-scratch resolve, no build
cargo check -p nysiris-transport-nym --features nym --locked   # heavy, real nym-sdk
```

Bump the pin deliberately (consumers break on a pointer change, not silently):

```bash
git -C core fetch --tags
git -C core checkout vX.Y.Z
git add core .gitmodules      # .gitmodules only if the URL/branch changed
git commit -m "core: bump nysiris-core to vX.Y.Z"
```

Then run the consumer smoke test: build NCC against the new tag and let this
repository's CI prove the pinned submodule still builds and still produces the
shared DM vectors. If the DM bytes changed, regenerate the fixture in the core
repository with
`cargo run -p nysiris-core --example dm_vectors > crates/nysiris-core/tests/fixtures/dm-v2.json`
and copy it verbatim to `web/test/fixtures/nysiris-core-dm-v2.json` in the same
change; a byte-level mismatch fails CI. This is a CI/test relationship across
repositories — never a Cargo path dependency from this workspace.

Releases are cut in the core repository by bumping
`[workspace.package].version`, committing that bump, and tagging that same
commit — annotated, so `git submodule status` displays it:
`git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`. The release workflow
verifies the tag against `[workspace.package].version` and fails on a mismatch,
runs the full gate including the `nym` feature compile, and publishes in
dependency order when `CORE_PUBLISH_ENABLED` and `CARGO_REGISTRY_TOKEN` are
configured. Never move or re-tag an existing version.

> The Nym `1.22.x` patch line is internally inconsistent:
> `nym-client-core` 1.22.2 requires the yanked `tokio_with_wasm` 0.10.1, while
> the 1.22.1 fallback does not compile against its 1.22.2 siblings.
> `core/Cargo.lock` pins the mainnet-verified 1.22.0 set, and since `v0.1.2`
> `nysiris-transport-nym` also pins every Nym crate exactly inside the `nym`
> feature, so a consumer resolving from scratch gets the same buildable tree.
> Build with `--locked`, and run `bash scripts/check-nym-pins.sh` after touching
> Nym pins or the lockfile.

---

## 14.6 Building on the core

Nysiris-Core is not app-private. The five crates are published on crates.io
through the `0.1.x` line, with `0.2.0` as the DM-compatible breaking release, and
can be used by any Rust project — a native client, a bot, a relay, a bridge, or
a mixnet-backed **microservice** — without depending on this repository or
inheriting its UI and release cadence.

```toml
[dependencies]
nysiris-core = "0.2"
nysiris-chat-core = "0.2"
nysiris-chat-history = "0.2"

[dependencies.nysiris-transport-nym]
version = "0.2"
features = ["nym"]          # real nym-sdk adapter

[dev-dependencies]
nysiris-testkit = "0.2"
```

To pin source exactly, depend on the tag instead of the registry:
`nysiris-core = { git = "https://github.com/TribeWarez/nysiris-core", tag = "v0.2.0" }`.

What makes it reusable:

* `nysiris-core` is Nym-free and UI-free; only `nysiris-transport-nym` pulls
  `nym-sdk`, and only with `features = ["nym"]` (default builds get an explicit
  unavailable stub, so test suites stay fast).
* `History` is encrypted flat files — no SQLite and no plaintext at rest.
* `Transport` is a two-method trait (`name`, `send`), so a host can supply its
  own delivery: Nym, a local queue, a test mock.
* DM domains are `fly-social-v1/dm` and `fly-social-v1/dm-inner`, shared with
  the browser; only rooms use `nysiris-chat-v1/*`.
* Wire compatibility with the browser client is a contract enforced by the
  shared fixture and cross-repository CI: changing the DM envelope, history
  binding or room format requires versioning the domain and updating both
  implementations.

Consumers pin a tag or crates.io version and verify in their own CI. Do not copy
the crates into a host repository — fix them upstream and cut a release.

---

## 14.7 Migration checklist

Done:

- [x] Chat identity, contacts, message types, sealed DM crypto.
- [x] Signed inner envelope bound to `from`/`ts`/`msgId`/body/attachments,
      byte-exact with the browser (`fly-social-v1/dm-inner` v2).
- [x] Encrypted flat-file history (no SQLite, no plaintext at rest).
- [x] `Transport` trait + in-memory testkit.
- [x] `nym-sdk` transport adapter (`NymTransport`), verified on mainnet with two
      native daemons (DM and room delivery).
- [x] Standalone repository, tag `v0.2.0`, Apache-2.0, security policy.
- [x] Submodule at `core/` in this repository, pinned `v0.2.0` (`990fdff`).
- [x] Shared DM vector fixture, generated in core and mirrored byte-for-byte in
      `web/test/fixtures/nysiris-core-dm-v2.json`.
- [x] Cross-repo CI: the `core-submodule` job checks out the pinned revision,
      verifies the vectors match, and runs core fmt/clippy/tests; the web suite
      re-derives the vectors with browser crypto.
- [x] Published on crates.io in dependency order as `0.1.3`/`0.1.4` (all five
      crates; GitHub releases created, docs.rs at 100% item coverage).

Next:

- [ ] Service-side crates (`nysiris-service`, `nysiris-social-protocol`) so
      `services/*` can consume the same protocol instead of local copies.
- [ ] wasm build of `nysiris-core` (Nym-free parts only) to share the envelope
      and history formats with the browser client.
- [ ] NCC pin bump to `v0.2.0` and an NCC-side wire test (NCC is a separate
      repository).
- [ ] Retire duplicated DM framing in `web/src/application/dm.ts` once the wasm
      binding exists.

---

## 14.8 Related reading

* [`01-architecture.md`](01-architecture.md) — where the core sits in the
  system view.
* [`02-addressing-and-routing.md`](02-addressing-and-routing.md) — Nym
  addresses, SURBs and the packet format the transport carries.
* [`09-social.md`](09-social.md) — the social provider and its own wire format.
* [`13-sdk-cli.md`](13-sdk-cli.md) — hosting SDK and CLI.
* [`05-security.md`](05-security.md) — threat model; DM and history controls.
