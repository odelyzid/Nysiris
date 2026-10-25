# 14. Nysiris-Core: extracted protocol & transport

> **Status: partial extraction, published base.** The native chat protocol and
> the Nym transport seam live in
> [`TribeWarez/nysiris-core`](https://github.com/TribeWarez/nysiris-core),
> vendored here as the `core/` submodule (pinned `v0.1.2`) and published on
> crates.io as `0.1.2` for anyone to build on. The browser client, the social
> provider, the hosting abstractions and the reference Sphinx implementation are
> still in this repository. This page records what moved, what did not, how to
> consume it, and the rules that keep the two repositories from drifting.

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
  immutable, so a release is cut by tagging the workspace version; `0.1.2` is
  the first published set).
* CI here validates the extraction as a consumer would — by building the
  submodule against its own lockfile, not by merging dependency graphs.

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

They must stay byte-compatible: the DM construction and envelope fields below
are the contract, and a change on one side needs a change (and a test vector)
on the other.

---

## 14.4 Wire & crypto invariants

Do not change these without versioning the domain and updating both
implementations:

* **Identity**: ed25519 keypair; the public key converts to X25519 for DH.
* **Sealed DM**: ephemeral X25519 → `BLAKE2b-256` KDF (`nysiris-chat-v1/dm`) →
  `XChaCha20-Poly1305`; `SealedDm { v, epub, nonce, ciphertext }` is hex on the
  wire.
* **Inner envelope**: signed and bound to `from`, `to`, `ts`, `msgId`, and the
  body — the recipient can attribute a DM even though the provider cannot read
  it.
* **History**: each record is a sealed blob; the hashed conversation filename
  is bound as AEAD associated data, so records cannot be replayed into another
  conversation.
* **Rooms**: a random capability key is shared in a signed invite; the sender
  seals once and fans out to at most 16 members. There is no relay roster;
  removing a member means a new room key.
* **Domains** are `nysiris-chat-v1/*`. Do **not** reuse the social
  `fly-social-v1/*` domains or copy provider routes.
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
git submodule status          # a44cc98... — tagged v0.1.2
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

Then run the consumer smoke test: build NCC and the Nysiris services against the
new tag. That is a CI/test relationship across repositories — never a Cargo
path dependency from this workspace.

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

Nysiris-Core is not app-private. The five crates are published on crates.io as
`0.1.2` and can be used by any Rust project — a native client, a bot, a relay, a
bridge, or a mixnet-backed **microservice** — without depending on this
repository or inheriting its UI and release cadence.

```toml
[dependencies]
nysiris-core = "0.1.2"
nysiris-chat-core = "0.1.2"
nysiris-chat-history = "0.1.2"

[dependencies.nysiris-transport-nym]
version = "0.1.2"
features = ["nym"]          # real nym-sdk adapter

[dev-dependencies]
nysiris-testkit = "0.1.2"
```

For unreleased work, depend on the tag instead of the registry:
`nysiris-core = { git = "https://github.com/TribeWarez/nysiris-core", tag = "v0.1.2" }`.

What makes it reusable:

* `nysiris-core` is Nym-free and UI-free; only `nysiris-transport-nym` pulls
  `nym-sdk`, and only with `features = ["nym"]` (default builds get an explicit
  unavailable stub, so test suites stay fast).
* `History` is encrypted flat files — no SQLite and no plaintext at rest.
* `Transport` is a two-method trait (`name`, `send`), so a host can supply its
  own delivery: Nym, a local queue, a test mock.
* Domains stay `nysiris-chat-v1/*`; consumers must not reuse the social
  `fly-social-v1/*` domains.
* Wire compatibility with the browser client is a contract: changing the DM
  envelope, history binding or room format requires versioning the domain and
  updating both implementations.

Consumers pin a tag or crates.io version and verify in their own CI. Do not copy
the crates into a host repository — fix them upstream and cut a release.

---

## 14.7 Migration checklist

Done:

- [x] Chat identity, contacts, message types, sealed DM crypto.
- [x] Signed inner envelope bound to `from`/`to`/`ts`/`msgId`/body.
- [x] Encrypted flat-file history (no SQLite, no plaintext at rest).
- [x] `Transport` trait + in-memory testkit.
- [x] `nym-sdk` transport adapter (`NymTransport`), verified on mainnet with two
      native daemons (DM and room delivery).
- [x] Standalone repository, tag `v0.1.2`, Apache-2.0, security policy.
- [x] Submodule at `core/` in this repository, pinned `v0.1.2`.
- [x] Published on crates.io in dependency order as `0.1.2` (all five crates;
      release gate green, GitHub release created).

Next:

- [ ] Service-side crates (`nysiris-service`, `nysiris-social-protocol`) so
      `services/*` can consume the same protocol instead of local copies.
- [ ] wasm build of `nysiris-core` (Nym-free parts only) to share the envelope
      and history formats with the browser client.
- [ ] Cross-repo CI: build Nysiris + NCC against the changed core revision.
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
