# fly-social provider

Metadata-minimal microblog + encrypted-DM dead-drop hidden service.
Full design: [`docs/09-social.md`](../../docs/09-social.md).

## Run

```sh
SP_DATA_DIR=./sp-storage SOCIAL_DB=./social.sqlite cargo run --release
# SP_GATEWAY=<gateway-identity-key>  # optional: pin for a stable address
```

Prints its Nym address on startup (also written to `./nym-address.txt`).
Paste it into the app's **fly-social** section or top URI bar.

## API

```text
GET  /                               (service descriptor)
GET  /health
GET  /feed?since=<seq>&limit=<n>
POST /post    {author,day,body,sig}
GET  /profile/<hex64>
POST /profile {author,name,bio,day,sig}
POST /dm      {to,epub,nonce,ciphertext}
GET  /dm?for=<hex64>   (destructive read)
```

Every write is ed25519-signed over a domain-separated message and verified
before storage; unsigned or stale-day (±2d) writes get 400s.

## Operations

* **Back up both**: `sp-storage/` (identity = the address) and `social.sqlite`
  (data). Lose either and the service is gone.
* **At-rest protection**: LUKS on the volume + `chmod 600 social.sqlite`.
  The file is plaintext SQLite by default (SQLCipher only if you can name the
  adversary LUKS doesn't stop — see `docs/09-social.md` §9.1).
* **What the DB holds**: post bodies, author pubkeys, coarse days, profiles,
  opaque DM ciphertext. No IPs, Nym addresses, timestamps, follows, likes,
  or receipts — by construction, not policy.
* **Build note**: `rusqlite` is pinned to 0.32 because `nym-sdk` (via sqlx)
  already links `libsqlite3-sys 0.30` — only one crate may link the native
  library. Do not upgrade past 0.32 without checking sqlx's sys version.

## Tests

```sh
cargo test --release   # 7 tests: sig vectors, store CRUD/pagination/DM lifecycle, dispatch routes
```
