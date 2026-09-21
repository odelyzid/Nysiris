# hybrid-bridge

Serve one backend through the **Nym mixnet**, with two variants:

| Variant | Clearnet? | Compose file | When |
|---|---|---|---|
| **mixnet-only (B-private)** | **NONE — zero clearnet** | `docker-compose.mixnet-only.yml` | **default for privacy**: real HTTP service, reachable only by Nym address |
| hybrid + clearnet | yes via Caddy :443 | `docker-compose.yml` | you also need ordinary browsers |

```
# B-private (this section):
mixnet clients ──▶ hybrid-bridge (nym, outbound WSS only) ──▶ app (internal net)

# classic hybrid (other compose file):
clearnet users  ──▶ Caddy :443 ─────────────┐
                                            ├──▶ app (nginx / your service)
mixnet clients  ──▶ hybrid-bridge (nym) ────┘
```

The bridge is a normal Nym client embedded in a small HTTP forwarder — it is
*not* an exit gateway and carries no outproxy liability.

## B-private: mixnet-only (no clearnet at all)

```sh
docker compose -f docker-compose.mixnet-only.yml up --build
docker compose -f docker-compose.mixnet-only.yml logs bridge  # Nym address to share
./verify-no-clearnet.sh docker-compose.mixnet-only.yml        # proves zero surface
```

What makes it zero-clearnet:

* **No `caddy` service.** Deleted, not just stopped.
* **No `ports:` anywhere.** `docker ps` shows no `0.0.0.0:80->`, no `:::443->`.
* **Backend on `internal: true` network.** Only `bridge` can reach `http://app:80`.
* **Bridge dials OUT only** (WSS to its gateway). It binds no listener.
* **Hardened containers**: `read_only`, `no-new-privileges`, minimal tmpfs.
* **Host firewall**: default-deny inbound (see `firewall-no-inbound.sh`).

Verify any time:

```sh
./verify-no-clearnet.sh                        # static + live checks, fails closed
ss -tlnp | grep -E ':(80|443)\b' || echo "nothing on 80/443"
curl -sm 3 http://127.0.0.1/ && echo LEAK || echo "no clearnet"
```

### Firewall (host)

```sh
./firewall-no-inbound.sh          # UFW: deny incoming, allow outgoing
./firewall-no-inbound.sh --nft    # print nftables equivalent
```

Outbound stays open: the bridge **must** reach Nym gateways (WSS) and nym-api
(HTTPS) or it cannot send/receive. Inbound stays closed: nothing needs to reach
you — not clients, not gateways, not Caddy.

## Classic hybrid (clearnet + mixnet)

```sh
docker compose up --build
docker compose logs bridge   # prints the Nym address to share
```

Or locally:

```sh
BACKEND_URL=http://127.0.0.1:8080 SP_DATA_DIR=./bridge-storage cargo run --release
```

## Wire protocol

Requests and replies are small JSON envelopes; the backend stays Nym-unaware.

```json
{ "method": "GET", "path": "/api/status", "headers": {}, "body_base64": "" }
```

```json
{ "status": 200, "headers": { "content-type": "text/html" }, "body_base64": "...", "error": null }
```

## Safety properties (enforced in `bridge-guard`, unit-tested)

The guards live in the dependency-free [`bridge-guard`](../../crates/bridge-guard/)
crate so they run in the fast `cargo test -p bridge-guard` loop, not only in the
heavy nym-sdk build:

* Method allow-list (`GET/HEAD/POST/PUT/PATCH/DELETE`).
* `path` must start with `/`, must not start with `//`, must not contain `..`,
  and rejects percent-encoded traversal (`%2e`, `%2f`, `%5c`) and backslashes.
* Body size capped (`DEFAULT_MAX_BODY_BYTES`, 64 KiB).
* Only `content-type` / `accept` reach the backend; `authorization`, `cookie`
  and `host` are dropped.
* Redirects are not followed.
* No client identifiers are logged.

## Capacity

A single bridge client shares one ~50 packet/s budget across all mixnet clients.
Scale horizontally by running multiple bridges with **different identities**
(or the same identity only if you understand the trade-off) and load-balancing
is not possible at the Nym layer — clients pick an address, so run one bridge
per logical service.
