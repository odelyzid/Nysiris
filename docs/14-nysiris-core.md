# 14. Nysiris-Core: extracted protocol & transport

> **Status: partial extraction.** The native chat protocol and the Nym
> transport seam now live in
> [`TribeWarez/nysiris-core`](https://github.com/TribeWarez/nysiris-core),
> vendored here as the `core/` submodule (pinned `v0.1.1`). The browser client,
> the social provider, the hosting abstractions and the reference Sphinx
> implementation are still in this repository. This page records what moved,
> what did not, and the rules that keep the two repositories from drifting.

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
* The crates publish independently (`publish = false` for now; crates.io
  versions are immutable, so nothing is published until the API stabilizes).
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
git submodule status          # core (a031e9b...) v0.1.1
```

Verify the extracted workspace:

```bash
cd core
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo doc --workspace --no-deps
cargo check -p nysiris-transport-nym --features nym   # heavy, real nym-sdk
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

Releases are cut in the core repository by tagging the workspace version
(`git tag vX.Y.Z && git push origin vX.Y.Z`); its release workflow verifies the
tag against `[workspace.package].version`, runs the full gate including the
`nym` feature compile, and publishes in dependency order when
`CORE_PUBLISH_ENABLED` and `CARGO_REGISTRY_TOKEN` are configured. Never move or
re-tag an existing version.

> The Nym `1.22.x` patch line is internally inconsistent. `core/Cargo.lock` pins
> a known-good set; do not regenerate it without testing
> `--features nym`.

---

## 14.6 Migration checklist

Done:

- [x] Chat identity, contacts, message types, sealed DM crypto.
- [x] Signed inner envelope bound to `from`/`to`/`ts`/`msgId`/body.
- [x] Encrypted flat-file history (no SQLite, no plaintext at rest).
- [x] `Transport` trait + in-memory testkit.
- [x] `nym-sdk` transport adapter (`NymTransport`), verified on mainnet with two
      native daemons (DM and room delivery).
- [x] Standalone repository, tag `v0.1.1`, Apache-2.0, security policy.
- [x] Submodule at `core/` in this repository, pinned `v0.1.1`.

Next:

- [ ] Service-side crates (`nysiris-service`, `nysiris-social-protocol`) so
      `services/*` can consume the same protocol instead of local copies.
- [ ] Publish to crates.io in dependency order once the API stabilizes.
- [ ] wasm build of `nysiris-core` (Nym-free parts only) to share the envelope
      and history formats with the browser client.
- [ ] Cross-repo CI: build Nysiris + NCC against the changed core revision.
- [ ] Retire duplicated DM framing in `web/src/application/dm.ts` once the wasm
      binding exists.

---

## 14.7 Related reading

* [`01-architecture.md`](01-architecture.md) — where the core sits in the
  system view.
* [`02-addressing-and-routing.md`](02-addressing-and-routing.md) — Nym
  addresses, SURBs and the packet format the transport carries.
* [`09-social.md`](09-social.md) — the social provider and its own wire format.
* [`13-sdk-cli.md`](13-sdk-cli.md) — hosting SDK and CLI.
* [`05-security.md`](05-security.md) — threat model; DM and history controls.
