# nysiris-shop provider

Signed, metadata-minimal marketplace hidden service: listings, stock,
buyer/seller order threads, and raw signed reviews.
Full design: [`docs/16-shop.md`](../../docs/16-shop.md).

## Run

```sh
SP_DATA_DIR=./sp-storage SHOP_DB=./shop.sqlite cargo run --release
# SP_GATEWAY=<gateway-identity-key>  # optional: pin for a stable address
# SHOP_POW_BITS=16 SHOP_RATE_PER_DAY=200  # optional spam backstops
```

Prints its Nym address on startup (also written to `./nym-address.txt`).
Paste it into the app's Shop section or top URI bar.

## API

```text
GET  /                                     (service descriptor)
GET  /health
GET  /listings?offset=&limit=&q=&seller=
GET  /listing/<hex32>
POST /listing                              {seller,day,id,version,price,stock,currency,title,description,sig}
POST /listing/<hex32>/delete               {seller,day,sig}
POST /order                                {buyer,day,id,listing,qty,price,version,note,sig}
GET  /orders?for=<hex64>&day=&sig=<hex128>  (private to buyer/seller)
POST /order/<hex32>/status                 {actor,day,status,note,sig}
POST /order/<hex32>/message                {author,day,body,sig}
GET  /order/<hex32>/messages?for=&day=&sig=&offset=&limit=  (paged thread)
POST /review                               {author,day,order,seller,rating,body,sig}
GET  /reviews/<hex64>?offset=&limit=
POST /escrow/open                          {order,envelope}   (buyer-signed)
POST /escrow/event                         {order,envelope}   (one signed envelope)
GET  /escrow?for=<hex64>&day=&sig=<hex128>  (participant's sessions)
GET  /escrow/<hex32>?for=&day=&sig=<hex128> (session + signed envelope log)
```

Every write is ed25519-signed over a domain-separated message and verified
before storage; unsigned or stale-day (±2d) writes get 400s. Missing or
malformed signed numbers (`day`, `version`, `price`, `stock`, `qty`, `status`,
`rating`) are rejected by name instead of defaulting to zero; price `0` is a
valid free listing. State transitions
are stored with their signed proof and replayed by clients, so the provider
cannot report a status nobody signed. Prices are integer minor units (cents),
never floats. An order signs the listing's `price`/`version` at reservation; a
stale snapshot is refused, and the snapshot is returned with the order.
Order threads are capped at 500 signed messages; `/orders` embeds the latest
20 and `GET /order/<id>/messages` walks older pages with the same signed proof
of possession. The provider processes no payments; settlement is between the
parties.

## Escrow relay (stagenet reference)

For XMR listings, the optional escrow track in
[`docs/17-monero-escrow.md`](../../docs/17-monero-escrow.md) uses the shop as a
**signed-message relay only**. `POST /escrow/open` is bound to the signed order
(buyer, seller, and `amount = price × qty` in piconeros); `POST /escrow/event`
replays the whole signed log before accepting each new envelope. Reads require
proof of possession and are limited to the three named participants. The
service holds no wallet, seed, spend key, or funds, and has no mainnet mode.

## Order states

`reserved` → `accepted` → `fulfilled`; `reserved` → `declined` (seller);
`reserved|accepted` → `cancelled` (buyer). Declining or cancelling releases
availability; fulfilled units stay consumed. The signed `stock` is the
seller's maximum and is never rewritten — reads also return derived
`available`. Only a fulfilled order may be reviewed, once, by its buyer.

## Privacy model

* Listings are public: seller key, price, stock, title, description.
* Orders are private: `GET /orders` requires a signature over
  `fly-shop-v1/orders-read || for || day` with the buyer or seller key.
* Order notes and threads are for coordination only. **Never put shipping
  addresses in them** — trade those over the social service's encrypted DM
  dead-drop.
* Reviews are public and signed; there is no stored score. Clients re-verify
  the signatures and aggregate locally.

## Operations

* **Back up both**: `sp-storage/` (identity = the address) and
  `shop.sqlite` (data). Lose either and the service is gone.
* **At-rest protection**: LUKS on the volume + `chmod 600 shop.sqlite`.
  The file is plaintext SQLite by default (same reasoning as
  `docs/09-social.md` §9.1).
* **Build note**: `rusqlite` is pinned to 0.32 because `nym-sdk` (via sqlx)
  already links `libsqlite3-sys 0.30` — only one crate may link the native
  library. Do not upgrade past 0.32 without checking sqlx's sys version.

## Tests

```sh
cargo test --release   # signature/state grammar + store + dispatch routes
```
