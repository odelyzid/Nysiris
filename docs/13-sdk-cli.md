# 13. Hosting SDK & `nysiris` CLI

> The two layers a hidden-service operator actually depends on:
> `crates/nysiris-sdk/` (the **SDK**, nym-free) and `services/nysiris-cli/`
> (the **`nysiris` binary**, the only nym-sdk-aware half). Together they turn
> "copy the provider main loop" into "add one dependency and call `serve`".

---

## 13.1 Why it exists

Every service used to hand-copy the same ~30 lines: build a `MixnetClient`
over `StoragePaths`, optionally `request_gateway`, map `AnonymousSenderTag`
↔ `[u8; 16]`, run `wait_for_messages` / `send_reply`, and select on ctrl-c.
`docs/08-hidden-services.md` defines the abstraction; this document defines
the reusable hosting surface around it.

The split mirrors the repo's build philosophy:

| Layer | Crate | nym-sdk? | Runs in `./build.sh check` |
|---|---|---|---|
| Abstraction | `crates/nym-hidden-service` | no | yes |
| Runtime loop | `crates/provider-runtime` | no | yes |
| **SDK** | `crates/nysiris-sdk` | no | yes |
| **CLI** | `services/nysiris-cli` | yes | no (`./build.sh services`) |

Because the SDK is nym-free, its `HostConfig`, `serve`, and `StaticFiles` are
unit-tested in the fast loop; only the transport adapter needs the heavy build.

## 13.2 The SDK in one screen

```rust
use nysiris_sdk::{serve, HostConfig, HiddenService, Request, Response, MixnetRuntime};

struct Shop;

impl HiddenService for Shop {
    fn handle(&self, request: &Request) -> Response {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/") => Response::ok(200, "text/html", b"<h1>shop</h1>"),
            _ => Response::error(404, "unknown route"),
        }
    }
}

async fn run(runtime: &mut impl MixnetRuntime) {
    let config = HostConfig::from_env(); // data_dir, gateway, label
    serve(runtime, &Shop).await;         // wait → parse → validate → handle → reply
}
```

`serve` is the whole server harness: it reuses the shared
`provider_runtime::run_loop` and the hidden-service dispatch seam, so empty
payloads and senders without reply SURBs are dropped exactly as specified.
The nym-sdk adapter (the only part that needs the network) lives in the CLI;
a custom service can copy `nysiris-cli`'s `runtime.rs` (~40 lines) or depend on
the same pattern.

The crate also re-exports everything a host needs — `HiddenService`,
`Request`/`Response`, `NymUri`, `PetnameRegistry`, `chunk`, `Invite`,
`MixnetRuntime`, `Router`/`PowGuard`/`RateGuard`, `dispatch` — plus
`nysiris_sdk::prelude::*`.

## 13.3 `HostConfig`

| Field | Meaning | Default |
|---|---|---|
| `data_dir` | mixnet client storage (identity) | `./sp-storage` |
| `gateway` | gateway identity key to pin | `None` (automatic) |
| `label` | log label, never published | `nysiris-service` |
| `address_file` | where the address is written | `<data_dir>/nym-address.txt` |
| `write_address_file` | persist the address after connecting | `true` |

Resolved from flags, then `NYSIRIS_*`, then the historical `SP_*` names:

| Setting | Primary | Legacy |
|---|---|---|
| data dir | `NYSIRIS_DATA_DIR` | `SP_DATA_DIR` |
| gateway | `NYSIRIS_GATEWAY` | `SP_GATEWAY` |
| label | `NYSIRIS_SERVICE` | — |

`HostConfig::write_address` / `stored_address` own the address-file
convention, so tooling reads the same path the provider wrote.

## 13.4 The `nysiris` CLI

```
nysiris host <echo|files> [options]     run a hidden service
nysiris address [options]               print this host's stable Nym address
nysiris fetch <address|petname> [opts]  request a service and print the reply
nysiris petname <action>                manage local-only names
nysiris doctor [options]                validate config and local state
```

### Host a service

```bash
# trivial service, useful to prove connectivity / a toolchain
nysiris host echo --data-dir ./sp-storage

# a static site, reachable only by Nym address, no inbound port
nysiris host files --web-root ./public --index index.html \
  --address-out ./public/nym-address.txt
```

Both print the Nym address and write it to `--address-out` (default
`<data-dir>/nym-address.txt`). Pinning `--gateway <identity-key>` gives a
guaranteed-stable address (`docs/04-hosting-services.md` §3.3).

### Inspect and test

```bash
nysiris address --data-dir ./sp-storage        # stable address of that identity
nysiris fetch <id.enc@gw> --path /             # client-side smoke test
nysiris fetch shop --method POST --path /echo --body hi
nysiris petname add shop <id.enc@gw>
nysiris petname list
nysiris doctor
```

`fetch` connects an ephemeral client by default (one-shot reads do not need an
identity), sends a validated request envelope, and prints the status, headers,
and body. `petname` reads/writes the private registry from
`docs/08-hidden-services.md` §8.5 — never published anywhere.

## 13.5 Built-in services

| Service | Behaviour | Limits |
|---|---|---|
| `echo` | echoes the method, path, and body | one envelope |
| `files` | `GET`/`HEAD` a local directory | one message body; `413` above [`MAX_ONE_PACKET_BODY`] |

`files` is deliberately conservative:

* the request path is **never** percent-decoded, so encoding tricks cannot
  escape the web root (the `bridge-guard` rules already reject `..`, `%2e`,
  `%2f`, `%5c`, backslashes and protocol-relative paths);
* the resolved target is canonicalised and must stay inside the canonical
  root, which also defeats symlink escapes;
* only `GET`/`HEAD` are answered; anything else is `405`;
* bodies are capped at one mixnet message (`nysiris_sdk::files::
  MAX_ONE_PACKET_BODY` = 1400 raw bytes). Larger files return `413` until
  chunked transfer is wired (`docs/08-hidden-services.md` §8.6). `--max-bytes`
  raises the cap but oversized replies will not fit one Sphinx message.

## 13.6 Files

| Path | Purpose |
|---|---|
| `crates/nysiris-sdk/src/host.rs` | `HostConfig`, `serve`, address-file convention |
| `crates/nysiris-sdk/src/files.rs` | traversal-safe `StaticFiles` service |
| `crates/nysiris-sdk/src/lib.rs` | curated re-exports + `prelude` |
| `services/nysiris-cli/src/main.rs` | `nysiris` entry point + usage |
| `services/nysiris-cli/src/args.rs` | dependency-free parser (unit-tested) |
| `services/nysiris-cli/src/runtime.rs` | the nym-sdk `MixnetRuntime` adapter |
| `services/nysiris-cli/src/commands/` | `host`, `address`, `fetch`, `petname`, `doctor` |

## 13.7 Operations and security

* **No inbound ports.** The host dials out; replies travel only over SURBs
  (`docs/04-hosting-services.md` §3.1).
* **Persistent identity.** Back up `data_dir/` or the address changes; pin a
  gateway for stability across gateway churn.
* **Never log destinations.** The CLI prints the service's own address (meant
  for sharing) and request method/path, never client addresses.
* **One request at a time.** Messaging is request/response; bulk transfer
  remains the weakest workload (`docs/05-security.md` §5.2).

Next: **[`06-roadmap.md`](06-roadmap.md)** for the phased plan, or back to
**[`08-hidden-services.md`](08-hidden-services.md)** for the wire details.
