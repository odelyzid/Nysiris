# Self-hosted Nym Gateway (entry-gateway)

Run your **own entry gateway** so a service provider can have a guaranteed-stable
Nym address (the gateway identity is part of the address). This is *not* an exit
gateway: it does not route anyone to the clearnet, so it carries no exit
liability.

> Verified against `nym-node` v1.40.x. Always check the current
> [Nym operators guide](https://nym.com/docs/operators/nodes/nym-node/setup)
> before deploying.

## Requirements

* VPS with a **static, publicly routable IP** (not NAT/DMZ).
* Inbound ports: `1789` (mixnet), `9000` (client WebSocket); optionally `443`
  for WSS via a reverse proxy. Keep `8080` (HTTP API) and `1790` (verloc) tightly
  firewalled or bound to localhost/private interfaces.
* A Nyx wallet to **bond** the node. Unbonded nodes are not routable.
* Accept the Operator Terms & Conditions (required since `nym-node` 1.1.3).

## 1. Initialise

```bash
# writes ~/.nym/nym-nodes/my-gateway/config/config.toml without starting
./nym-node run \
  --id my-gateway \
  --init-only \
  --mode entry-gateway \
  --public-ips "$(curl -4 -s https://ifconfig.me)" \
  --hostname gateway.example.com \
  --location CH
```

Modes are mutually exclusive: `mixnode`, `entry-gateway`, `exit-gateway`,
`exit-providers-only`. Running more than one at a time makes the node
non-routable.

## 2. Configure

Edit `~/.nym/nym-nodes/my-gateway/config/config.toml` (see
`config.toml.example`) or pass `-w/--write-changes` with CLI flags. If you
terminate TLS elsewhere, set the announced WebSocket port so clients dial
`wss://gateway.example.com:443`.

## 3. Run under systemd

```bash
sudo cp nym-node.service /etc/systemd/system/nym-node.service
sudo useradd --system --home /var/lib/nym --shell /usr/sbin/nologin nym || true
sudo systemctl daemon-reload
sudo systemctl enable --now nym-node
journalctl -fu nym-node
```

## 4. Verify

```bash
curl -s http://127.0.0.1:8080/api/v1/roles
# then check the public HTTP API / Harbour Master for connectivity
```

## 5. Bond

Use the Nym Wallet "Bond" flow, or `nym-cli`/`nyxd`. You will need the node's
identity key and bonding signature:

```bash
./nym-node bonding-information --id my-gateway
```

## 6. Pin your service provider to it

The gateway identity is now part of your provider's address:

```sh
SP_GATEWAY=<gateway-identity-key> cargo run --release   # in services/echo-provider
```

The provider keeps **no inbound ports**; it only dials out to this gateway.

## Address stability trade-off

* If the gateway is down, every address pinned to it stops working.
* A gateway you run is still a **public** gateway: every Nym user may use it.
  You cannot run it exclusively for your own clients.
* Persistent provider storage keeps *your* keys; it cannot substitute for the
  gateway being online.
