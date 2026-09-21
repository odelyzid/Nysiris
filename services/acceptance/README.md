# Live-network acceptance test

A runnable check that the Nym integration works **against the real mixnet**:

1. **Delivery** — send a message to your own Nym address and receive it.
2. **Anonymous replies** — extract the `sender_tag` and reply over SURBs, never
   learning the sender's address.

This exercises exactly what `docs/04-hosting-services.md` (provider replies) and
`docs/05-security.md` §5.3 (SURBs) describe.

> It needs internet access to mainnet and the Nym SDK. It is intentionally
> **excluded from the fast workspace** because `nym-sdk` is large.

## 1. Get the Nym toolchain

You need Rust (1.87+) and network access. Then pick one:

### Option A — run the SDK crate (what this harness does)

No separate binary needed; `cargo` fetches `nym-sdk` from crates.io:

```sh
cd services/acceptance
cargo build --release      # first build downloads & compiles the Nym stack
```

### Option B — prebuilt Nym binaries (for the CLI smoke test)

Download `nym-client` / `nym-socks5-client` / `nym-node` from the official
releases page, then:

```sh
chmod +x nym-client
./nym-client init --id acceptance
./nym-client run --id acceptance
```

Use the printed address to send yourself a message from another client. See
Nym's "Standalone Clients" docs for details.

### Option C — build Nym from source (only if you need the binaries)

```sh
git clone https://github.com/nymtech/nym
cd nym && cargo build --release -p nym-client
```

This is heavy; prefer Option A unless you specifically need the CLI.

### Sandbox testnet (optional)

To avoid mainnet while experimenting, point the client at the Sandbox testnet
(see the SDK `sandbox` example). Set the relevant env/config in
`services/acceptance/src/main.rs` if you need it.

### Option D — build prerequisites for the SDK crates

`nym-sdk` pulls `aws-lc-sys`, which compiles native code. On Debian/Ubuntu:

```sh
sudo apt-get install -y build-essential cmake pkg-config
# some aws-lc-sys versions also want: sudo apt-get install -y nasm
```

If CMake/nasm are unavailable, use Option B (prebuilt binaries) instead.

## 2. Run the acceptance test

```sh
./build.sh acceptance
```

or directly:

```sh
cd services/acceptance
ACCEPTANCE_STORAGE=./acceptance-storage cargo run --release
```

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `ACCEPTANCE_EPHEMERAL` | unset | `1` = throwaway identity, no storage |
| `ACCEPTANCE_STORAGE` | `./acceptance-storage` | persistent key store (stable address) |
| `ACCEPTANCE_DEADLINE_SECS` | `180` | per-message wait timeout |

## 3. Expected output

An actual mainnet run:

```
connected as 3W1GuD2Qt8EdzkjGkcM44APmuKSsZtoRJ2z8awRvCWDh.2VkPto…@CmLp3GDh…
sent ping, waiting for delivery…
delivered in 7.6s: "acceptance ping 1789855214566"
got sender_tag GL25idL26wtbvRwvFGxMW5; replying over SURBs…
SURB reply received in 7.1s: "acceptance pong 1789855222171"

metrics:
  delivery_rtt_ms = 7605
  surb_reply_rtt_ms = 7093
  hop_model = entry -> 3 mix layers -> destination gateway (5 Sphinx hops)

ACCEPTANCE: PASS
```

Latency is expected to be **seconds**: that is the mixing mechanism, not a
fault. On the first run you may see:

```
WARN Not enough bandwidth. Trying to get more bandwidth, this might take a while
```

This is normal — the client is acquiring bandwidth (zk-nym) credentials before
sending.

### Verified environment

This harness passed against mainnet with Rust 1.94, `nym-sdk` 1.21.6,
CMake 3.28 and GCC 13.3. First build compiles the full Nym stack (~4–5 minutes
on a modern machine, ~37 MB binary).

## 4. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Stuck on "connecting" | No network, or mainnet `nym-api` unreachable. Check `curl https://validator.nymtech.net/api`. |
| `timed out … waiting for self-message` | Increase `ACCEPTANCE_DEADLINE_SECS`; first connect can be slow. |
| Persistently stuck handshake | Delete `acceptance-storage/` (or the browser IndexedDB) to force a fresh identity/gateway. |
| `sender_tag` missing | The message had no SURB bundle; ensure you are on a current `nym-sdk`. |
| Exit/proxy traffic refused | Proxy mode needs a valid zk-nym credential and an exit whose policy allows the port. End-to-end messaging (this harness) does not exit to clearnet. |
| Build fails fetching crates | Offline environment; run on a host with crates.io access. |

## What this does **not** prove

It proves delivery and anonymous replies end to end. It does **not** measure
anonymity, and it does not exercise the browser WASM path — that is covered by
`web/` and verified manually per `docs/03-browser-client.md`.
