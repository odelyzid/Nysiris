# echo-provider

A **pure-mixnet Nym service provider**: an application with an embedded Nym
client that is reachable only by its Nym address. No inbound ports, no clearnet
exposure, anonymous replies via SURBs.

## Run

```sh
export SP_DATA_DIR=./sp-storage          # persistent keys => stable address
# export SP_GATEWAY=<gateway-identity-key>  # optional: pin for stability
cargo run --release
```

On first run the provider generates keys, connects to an entry gateway, and
prints:

```
Service provider Nym address:
<identity>.<encryption>@<gateway>
```

It also writes the address to `./nym-address.txt`. Distribute it **out of
band** — there is no discovery system by design.

## Talk to it

Any Nym client that speaks the messaging shape (`wait_for_messages` /
`send_reply`), including the browser client in `web/`, can send to this address.
The SDK bundles SURBs automatically, so replies work without the provider ever
learning the sender's address.

### Verified end to end

```bash
# terminal 1
SP_DATA_DIR=./sp-storage cargo run --release
# -> Service provider Nym address: <id.enc@gw>

# terminal 2 (same crate, a separate client)
cargo run --release --bin provider-client -- "$(cat nym-address.txt)" "hello"
# -> sent in 15.1µs: "hello"
# -> anonymous reply in 1.571204715s: "echo: hello"
```

The provider logs `received N bytes: "…"` and `replied via SURB (N bytes)`.

### From the browser

The browser client (`web/`) reaches this provider too. It sends **raw UTF-8**
(`rawSend`) so the provider sees clean text, and listens on
`subscribeToRawMessageReceivedEvent`, decoding the reply with `TextDecoder`.
Verified: browser sends `"hello from the browser"` → provider logs
`received 22 bytes` / `replied via SURB (28 bytes)` → browser Inbox shows
`echo: hello from the browser`.

> Browser-side anonymous replies are not available in TS SDK 1.4.1 (no
> `senderTag`/`replyWithSurb`), so the browser can send and receive but cannot
> itself reply anonymously. Use the Rust SDK for that direction.

## Docker

```sh
docker build -t echo-provider .
docker run --rm -v "$PWD/sp-storage:/data" -e SP_DATA_DIR=/data echo-provider
```

## Operational notes

* **Back up `sp-storage/`.** It contains the identity and encryption keys; lose
  it and the address is gone.
* **Budget:** ~50 real packets/s and ~5 cover packets/s shared across all
  clients. Keep replies to one packet where possible.
* **Do not disable cover traffic** in production; it is what hides your
  activity shape.
* Replace `handle_request` with real logic. For bulk data use the SDK Stream
  module, not messaging.
