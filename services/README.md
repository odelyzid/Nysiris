# Hosting services

Three hosting methods, documented in
[`docs/04-hosting-services.md`](../docs/04-hosting-services.md):

| Directory | Method | Purpose |
|---|---|---|
| `echo-provider/` | **A. Pure mixnet** | Service reachable only by Nym address. No inbound ports. Recommended. |
| `nysiris-cli/` | **A. Pure mixnet** | The `nysiris` CLI: host `echo`/static `files`, print the address, `fetch` a service, manage petnames (`docs/13-sdk-cli.md`). |
| `hybrid-bridge/` | **B. Hybrid** | Same backend behind Caddy (clearnet) and a Nym bridge (mixnet). |
| `gateway/` | **C. Self-hosted Gateway** | Run an `entry-gateway` for a guaranteed-stable provider address. |

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
                                  # portal-provider, social, acceptance, nysiris-cli)
./build.sh services --skip-tests  # build only
```

> The bridging/provider code uses the `nym-sdk` **1.21.6** messaging API
> (`wait_for_messages` / `send_reply`; `nym-sdk` is the latest on crates.io).
> The API evolved from the v1.22 docs, so verify method names if you bump the
> dependency. The acceptance harness (`services/acceptance/`) is the executable
> check. `./build.sh check` validates the service manifests (fast, offline);
> full service builds stay behind `./build.sh services`.
