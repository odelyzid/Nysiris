# Hosting services

Three hosting methods, documented in
[`docs/04-hosting-services.md`](../docs/04-hosting-services.md):

| Directory | Method | Purpose |
|---|---|---|
| `echo-provider/` | **A. Pure mixnet** | Service reachable only by Nym address. No inbound ports. Recommended. |
| `nysiris-cli/` | **A. Pure mixnet** | The `nysiris` CLI: host `echo`/static `files`, print the address, `fetch` a service, manage petnames (`docs/13-sdk-cli.md`). |
| `hybrid-bridge/` | **B. Hybrid** | Same backend behind Caddy (clearnet) and a Nym bridge (mixnet). |
| `gateway/` | **C. Self-hosted Gateway** | Run an `entry-gateway` for a guaranteed-stable provider address. |
| `social/` | **A. Pure mixnet** | Metadata-minimal microblog + E2E DM dead-drop (`docs/09-social.md`). |
| `portal-provider/` | **A. Pure mixnet** | Portal data replication and reputation (`docs/10-portal.md`). |
| `shop/` | **A. Pure mixnet** | Signed marketplace: listings, stock-reserving orders, private threads, raw reviews (`docs/16-shop.md`). |

The reusable library behind the CLI is `crates/nysiris-sdk/` (workspace member,
nym-free); `nysiris-cli` is the only nym-sdk-aware half.

All crates here are **standalone** (excluded from the root Cargo workspace)
because they depend on the heavy `nym-sdk`/mixnet toolchain. Build each from its
own directory.

```sh
# pure mixnet provider
cd services/echo-provider && SP_DATA_DIR=./sp-storage cargo run --release

# hybrid clearnet + mixnet
cd services/hybrid-bridge && docker compose up --build
```

Build and test all services from the repo root (release profile, locked
dependencies; heavy first build — the `nym-sdk` toolchain):

```sh
./build.sh services               # all service crates
./build.sh services social        # just one (echo-provider, hybrid-bridge,
                                  # portal-provider, social, shop,
                                  # acceptance, nysiris-cli)
./build.sh services --skip-tests  # build only
```

> The bridging/provider code is pinned to the `nym-sdk` **1.21.6** messaging
> API (`wait_for_messages` / `send_reply`) in every service lockfile; the Nym
> 1.22.0 support crates are pinned alongside it. Verify method names if you
> bump the dependency. The acceptance harness (`services/acceptance/`) is the
> executable check. `./build.sh check` validates the manifests, lockfiles and
> absolute pin baseline (fast, offline); full service builds stay behind
> `./build.sh services`. Provider binaries write `./nym-address.txt` in their
> own service directory, while the SDK/CLI default is
> `<data_dir>/nym-address.txt`; both are intentional for their entry points.
