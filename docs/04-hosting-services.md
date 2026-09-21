# 3. Hosting a Web Server / Service Reachable via the Nym Mixnet

> Section [2] of the original brief. Three methods, from strongest privacy to
> most operationally involved. The exact addressing clients use is in
> §3.4. Code lives under `services/`.

---

## 3.0 Choose a method

| Method | Service has a Nym address? | Clearnet reachable? | Inbound ports needed? | Exit Gateway involved? | Privacy |
|---|---|---|---|---|---|
| **A. Pure mixnet provider** | ✅ (stable) | ❌ | **None** | ❌ | Strongest |
| **B-private. Hybrid mixnet-only** | ✅ | ❌ **zero clearnet** | **None** | ❌ for mixnet path | Strongest for HTTP |
| **B. Hybrid (bridge)** | ✅ | ✅ (via Caddy/nginx) | 443 only (clearnet) | ❌ for mixnet path | Good |
| **C. Self-hosted Gateway + service** | ✅ (pinned to your Gateway) | optional | 1789/9000/443 | ❌ for mixnet path | Strongest + stable address |

The recommended default is **A**, or **B-private** when you have a real HTTP
app but want **no clearnet at all**. Use classic **B** only when ordinary web
users must reach you. **C** is only necessary when you must guarantee address
stability or operate network infrastructure.

```
                         ┌─────────────────────────── your server ───────────────────────────┐
                         │                                                                    │
mixnet ──▶ Gateway ─────▶│  nym client (embedded)  ──▶  your app  ──▶  local DB / RPC / ...    │
                         │        (outbound WSS only; no inbound port)                        │
                         │                                                                    │
clearnet ──▶ :443 ──────▶│  Caddy / nginx  ─────────▶  same app                              │
                         │                                                                    │
                         └────────────────────────────────────────────────────────────────────┘
```

---

## 3.0b Quick start: host and connect (verified)

### A. Pure mixnet service (no web server, no inbound ports)

```bash
# terminal 1 — the service
cd services/echo-provider
SP_DATA_DIR=./sp-storage cargo run --release
# prints: Service provider Nym address: <id.enc@gw>

# terminal 2 — a client reaches it by that address
cargo run --release --bin provider-client -- "$(cat nym-address.txt)" "hello"
# -> sent in 15µs; anonymous reply in ~1.6s: "echo: hello"
```

From the browser: **Start messaging client** → paste the address into the
recipient field → **Send**. Verified end to end.

### B. Hybrid: a real HTTP web service behind the mixnet

```bash
# 1. your web app (any HTTP server: nginx, Caddy, your own)
python3 -m http.server 8081 --bind 127.0.0.1

# 2. the bridge: an embedded Nym client that forwards to the backend
cd services/hybrid-bridge
BACKEND_URL=http://127.0.0.1:8081 SP_DATA_DIR=./bridge-storage cargo run --release
# prints: Hybrid bridge Nym address: <id.enc@gw>

# 3. connect over the mixnet by sending the request envelope to that address
{"method":"GET","path":"/","headers":{},"body_base64":""}

# reply (verified):
{"status":200,"headers":{"content-type":"text/html"},"body_base64":"PCFkb2N0eXBlIGh0bWw+…"}
```

The backend sees an ordinary local call (`GET / HTTP/1.1 200`); the bridge opens
no inbound ports.

### B-private: same HTTP service, ZERO clearnet (recommended for privacy)

No Caddy. No `ports:`. No inbound firewall rule. Real HTTP backend, reachable
only by Nym address:

```bash
cd services/hybrid-bridge
docker compose -f docker-compose.mixnet-only.yml up --build
docker compose -f docker-compose.mixnet-only.yml logs bridge  # Nym address
./verify-no-clearnet.sh docker-compose.mixnet-only.yml        # proves it
```

Architecture:

```
mixnet clients ──▶ bridge (outbound WSS only) ──▶ app (internal:true network)
clearnet users ──▶ NOTHING (no listener, no port, no proxy)
```

* `app` is on an `internal: true` Docker network — only `bridge` reaches
  `http://app:80`. Compose publishes nothing.
* `bridge` binds nothing; it dials OUT to its Nym gateway.
* Containers run `read_only` + `no-new-privileges`.
* Host firewall default-deny inbound (`firewall-no-inbound.sh`); outbound stays
  open (gateway WSS + nym-api need it).
* Private nginx profile (`nginx.private.conf`): `server_tokens off`,
  `access_log off`, hidden-file denials.

Add Caddy in front for simultaneous clearnet access —
`services/hybrid-bridge/docker-compose.yml` wires both front doors to one app.

## 3.1 Method A — Pure mixnet Service Provider (recommended)

### How it works

A service provider is **an ordinary Nym client embedded in your app**. It:

* dials **out** to its Gateway over WSS (so it can run behind a deny-all
  firewall, in a DMZ, with no public IP);
* the Gateway stores incoming messages while the provider is briefly offline;
* requests arrive as Sphinx packets. Each carries a bundle of **SURBs**
  (single-use reply blocks) pre-computed by the client;
* the provider replies with `send_reply(sender_tag, ...)` — it **never learns
  the client's address**, and the client never learns the provider's IP.

```
mixnet ──▶ your app + embedded Nym client ──▶ backend it already talks to
             (this is what you modify)         (unchanged, no Nym awareness)
```

### The one rule that matters most: persistent identity

`MixnetClient::connect_new()` / `new_ephemeral()` generate a **fresh address on
every restart**, breaking every client that cached the old one. Real providers
must use on-disk storage:

```rust
let paths = StoragePaths::new_from_dir("./sp-storage")?;
let mut client = MixnetClientBuilder::new_with_default_storage(paths)
    .await?
    .build()?
    .connect_to_mixnet()
    .await?;
```

### Pin the Gateway for a stable address

The Gateway identity is **part of the address**. To guarantee stability, run
your own Gateway (§3.3) and pin the provider to it:

```rust
let builder = MixnetClientBuilder::new_with_default_storage(paths)
    .await?
    .request_gateway("<gateway-identity-key>");
```

### Runnable example

See [`services/echo-provider/`](../services/echo-provider/). It uses the
**messaging** API (`wait_for_messages` / `send_reply`) — the only shape a
browser client can speak today.

```rust
use nym_sdk::mixnet::{MixnetClientBuilder, MixnetMessageSender, StoragePaths};

let paths = StoragePaths::new_from_dir(std::env::var("SP_DATA_DIR")?)?;
let mut builder = MixnetClientBuilder::new_with_default_storage(paths).await?;
if let Ok(gw) = std::env::var("SP_GATEWAY") {
    builder = builder.request_gateway(gw);
}
let mut client = builder.build()?.connect_to_mixnet().await?;
println!("Nym address: {}", client.nym_address());

while let Some(messages) = client.wait_for_messages().await {
    for msg in messages {
        if msg.message.is_empty() { continue; }        // SURB replenishment
        let Some(tag) = msg.sender_tag else { continue; };
        client.send_reply(tag, handle(&msg.message)).await?;
    }
}
```

Run:

```bash
cd services/echo-provider
SP_DATA_DIR=./sp-storage cargo run --release
# prints: Nym address: <id>.<enc>@<gateway>
```

Or with Docker:

```bash
docker build -t echo-provider services/echo-provider
docker run --rm -v "$PWD/sp-storage:/data" -e SP_DATA_DIR=/data echo-provider
```

### Verified round trip (mainnet)

This exact flow was run against mainnet: the provider was started, and a
**separate client reached it purely by Nym address** — no inbound port, no
clearnet endpoint, and the provider never learned the client's address.

```
$ SP_DATA_DIR=./sp-storage cargo run --release
Service provider Nym address:
CpJbfEuhMdKBdztyF3WhNdmupkiTRqxrn6EKA3cbAbQ1.DLPmXTqD6yvRqJxmBMeBfkF1HuGW3r8TUVRoZA7E6ZPc@GJqd3ZxpXWSNxTfx7B1pPtswpetH4LnJdFeLeY5KUuN

# the ordinary client in the browser receives a "sender_tag" and replies via SURB
```

A minimal client is included in the same crate:

```bash
cd services/echo-provider
cargo run --release --bin provider-client -- "$(cat nym-address.txt)" "hello hosted service"
# provider:   CpJbfEuh…@GJqd3Zxp…
# client address: EwZ8rKQG…@62c8JqJC…
# sent in 15.1µs: "hello hosted service"
# anonymous reply in 1.571204715s: "echo: hello hosted service"
```

The provider prints `received N bytes: "…"` and `replied via SURB (N bytes)`
for each request.

### Budget and capacity (design for this up front)

The client sends on a **fixed Poisson schedule** whether or not you have data:

| Stream | Default | Rate |
|---|---|---|
| Real packets | 1 every 20 ms | ~50/s |
| Loop cover packets | 1 every 200 ms | ~5/s |
| **Total** | | **~55 pkt/s** |

Consequences:

* **Capacity is shared.** Every reply to every client comes out of ~50 real
  packets/s. Measure reply sizes; run multiple provider clients when saturated.
* **Idle is not free.** With nothing to send you emit cover traffic — same size,
  same rate, same CPU.
* **It never stops.** The provider and its Gateway exchange this stream
  continuously.

Every reply consumes one SURB; clients must pre-send enough. Bulk transfers
(syncing a chain, streaming media) exhaust the SURB budget — use the **Stream**
module (`listener()`/`accept()`) or `smolmix` for that, not messaging.

### What this method guarantees

* No clearnet IP for the service is ever exposed.
* Client↔provider content stays Sphinx-encrypted across the mixnet; your
  process decrypts it before it reaches anything downstream.
* The Gateway learns the *provider's* IP (it is the provider's own Gateway) but
  not which client is talking to it.

---

## 3.2 Method B — Hybrid / clearnet-facing

You want ordinary browsers (clearnet) **and** mixnet clients to reach the same
application. The pattern is a **shared backend** with two front doors:

```
clearnet users ──▶ Caddy :443 ─────────────┐
                                           ├──▶ app (localhost / compose network)
mixnet clients ──▶ mixnet-bridge (nym-sdk) ─┘
```

* **Caddy / nginx** terminates TLS for the public web.
* **`services/hybrid-bridge/`** embeds a Nym client, receives mixnet requests,
  forwards them to the backend over the local network, and returns the response
  as a SURB reply.

This is **not** an Exit Gateway: the bridge is a normal Nym client, so no
outproxy policy or exit liability is involved. The bridge is the "reverse proxy
that accepts Sphinx packets and forwards to a local web server".

### `docker-compose.yml` (see `services/hybrid-bridge/`)

```yaml
services:
  app:
    image: nginx:alpine
    volumes:
      - ./public:/usr/share/nginx/html:ro
    expose: ["80"]

  bridge:
    build: ./bridge
    environment:
      SP_DATA_DIR: /data
      BACKEND_URL: http://app:80
    volumes:
      - bridge-data:/data
    depends_on: [app]
    restart: unless-stopped
    # no ports: the bridge only dials out

  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    depends_on: [app]

volumes:
  bridge-data:
  caddy-data:
```

### `Caddyfile`

```
example.com {
    encode zstd gzip
    reverse_proxy app:80
}
```

nginx equivalent (server block): `location / { proxy_pass http://app:80; }`
with `proxy_set_header Host $host; X-Forwarded-For $remote_addr;`.

### The bridge request shape

Mixnet messages are opaque bytes, so define a tiny envelope the bridge
understands. Keep it minimal and validate hard:

```json
{ "method": "GET", "path": "/api/status", "headers": {}, "body_base64": "" }
```

Response:

```json
{ "status": 200, "headers": {}, "body_base64": "..." }
```

The bridge **must**:

* allow-list methods and paths (never forward arbitrary absolute URLs — that
  would turn it into an open proxy);
* cap body size to the Sphinx plaintext limit (≤ 2031 bytes per packet);
* never log client identifiers.

### Variant B2 — using an Exit Gateway to reach *someone else's* clearnet service

This is the opposite direction (you are the client). You do **not** host
anything. A browser or `nym-socks5-client` sends a SOCKS5 request through the
mixnet to an Exit Gateway's Network Requester, which connects to the clearnet
site. The site sees the Exit Gateway's IP. Useful when *you* want to browse, not
when *you* want to host.

### Variant B3 — "reverse proxy that accepts Sphinx packets"

That is exactly the bridge above. There is no need for a special reverse proxy
plugin; the Nym client *is* the ingress.

---

## 3.3 Method C — Self-hosted Nym Gateway + service

Only needed for **guaranteed address stability** or if you are operating
infrastructure. Two parts: run a `nym-node` in `entry-gateway` mode (the
Gateway that holds your provider's mailbox), and pin your provider to it.

> Running an **exit** gateway is a separate, higher-risk decision (you route
> other people's traffic to the open internet and receive abuse complaints).
> See Nym's Community Counsel pages before doing it. This section covers an
> **entry** gateway, which is what address stability requires.

### Requirements

* A VPS with a **static, publicly routable IP** (not in a DMZ behind NAT).
* Ports: **1789** mixnet, **9000** client WebSocket, **8080** HTTP API
  (bind to localhost or firewall), **1790** verloc.
* A Nyx wallet to bond the node.

### Current `nym-node` surface (v1.40.x)

Modes: `--mode mixnode | entry-gateway | exit-gateway | exit-providers-only`.
Run **exactly one** mode; multiple modes make the node non-routable.

Config lives at `~/.nym/nym-nodes/<ID>/config/config.toml`. `run` initialises
on first use; `--init-only` writes config without starting; `-w/--write-changes`
applies CLI overrides to the file.

### Initialise and run an entry gateway

```bash
# one-off: accept T&Cs explicitly, announce your public IP
./nym-node run \
  --id my-gateway \
  --mode entry-gateway \
  --public-ips "$(curl -4 -s https://ifconfig.me)" \
  --hostname gateway.example.com \
  --location CH \
  --accept-operator-terms-and-conditions \
  --wireguard-enabled true
```

Initialise only (recommended, then inspect `config.toml`):

```bash
./nym-node run --id my-gateway --init-only --mode entry-gateway \
  --public-ips "$(curl -4 -s https://ifconfig.me)" \
  --hostname gateway.example.com --location CH
```

Get the **gateway identity key** to pin your provider:

```bash
./nym-node node-details --id my-gateway
# or, from the running node:
curl -s http://127.0.0.1:8080/api/v1/roles
```

Then pin the provider:

```rust
.request_gateway("<gateway-identity-key>")
```

### `config.toml` (abridged template — see `services/gateway/config.toml.example`)

```toml
[host]
public_ips = ["203.0.113.10"]
hostname = "gateway.example.com"
location = "CH"

[mixnet]
bind_address = "0.0.0.0:1789"

[entry]
bind_address = "0.0.0.0:9000"
# Set when behind a reverse proxy terminating WSS:
# announce_ws_port = 443

[http]
bind_address = "127.0.0.1:8080"

[verloc]
bind_address = "0.0.0.0:1790"

# [wireguard]
# enabled = true
# bind_address = "0.0.0.0:51822"
```

### systemd unit

```ini
[Unit]
Description=Nym Node (entry-gateway)
After=network-online.target
Wants=network-online.target

[Service]
User=nym
LimitNOFILE=65536
ExecStart=/usr/local/bin/nym-node run --id my-gateway --mode entry-gateway --accept-operator-terms-and-conditions
KillSignal=SIGINT
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nym-node
journalctl -fu nym-node
```

### Bond the node

Use the Nym Wallet "Bond" flow or `nym-cli` (`nyxd` for chain ops). You will
need the node's identity/sphinx keys and bonding signature from
`nym-node bonding-information`. Unbonded nodes are not routable.

### WSS / reverse proxy

Clients prefer WSS (`wss://gateway.example.com:443`). Terminate TLS with
Caddy/nginx and proxy the WebSocket upgrade to `127.0.0.1:9000`; advertise the
proxied port in config. See Nym's "WSS & Reverse Proxy" operator page.

### DMZ split (the point of all this)

```
public  ──▶ Gateway VPS (1789/9000/443)   static IP, bonded
                │
                │  outbound WSS only
                ▼
private ──▶ provider host (no inbound ports, deny-all firewall)
                └─ app + embedded nym client, address pinned to your gateway
```

---

## 3.4 The exact addressing format clients use

A client addresses your service by one string:

```
<identity-key>.<encryption-key>@<gateway-identity-key>
```

* Three base58 32-byte keys. Example from Nym's docs:
  `DguTcdkWWtDyUFLvQxRdcA8qZhardhE1ZXy1YCC7Zfmq.Dxreouj5RhQqMb3ZaAxgXFdGkmfbDKwk457FdeHGKmQQ@4kjgWmFU1tcGAZYRZR57yFuVAexjLbJ5M7jvo3X5Hkcf`
* Your provider prints it on startup. Distribute it **out of band** — there is
  deliberately no discovery system, because clients should not be enumerable.
* Pin it in client config, a QR code, a signed release, or an ENS record.

Programmatic use (reference Sphinx crate):

```rust
let addr = sphinx_core::NymAddress::parse(s)?;
let destination = addr.destination_address();   // final Sphinx layer
let gateway     = addr.gateway_identity();      // which Gateway holds the mailbox
```

Browser use: pass the string to `client.send({ recipient, data })` and reply via
the SDK's `sender_tag` / `send_reply` (see `docs/03-browser-client.md`).

---

## 3.5 Operations checklist

**Security**
- [ ] Provider has **no inbound ports**; egress only to its Gateway.
- [ ] Keys on encrypted storage; back up `sp-storage/` or you lose the address.
- [ ] Never log Nym addresses, destinations, or payloads.
- [ ] Hybrid bridge uses a strict method/path allow-list (no open proxy).
- [ ] If you run an exit: explicit exit policy, abuse process, legal review.

**Reliability**
- [ ] Provider is supervised (systemd/Docker `restart: unless-stopped`).
- [ ] Gateway IP is static and bonded if self-hosted.
- [ ] Monitor message queue depth and reply rate vs the ~50 pkt/s budget.
- [ ] Plan SURB replenishment for chatty clients; size replies to packets.

**Privacy**
- [ ] Register/re-register the same keys and the same Gateway on restart
      (persistent storage + `request_gateway`).
- [ ] Decide identity lifetime deliberately: ephemeral vs persistent.
- [ ] Keep cover traffic on in production; disabling it leaks activity shape.

**Limits (state these to stakeholders)**
- [ ] Messaging suits request/response, not bulk transfer.
- [ ] A service provider cannot accept inbound TCP connections; it only replies.
- [ ] If the pinned Gateway disappears, the address stops working.

---

Next: **[`03-browser-client.md`](03-browser-client.md)** — the cross-platform
(web + Android) client that speaks to these services.
