# portal-provider

Content-addressed object + append-only log storage for the portal system.
**Data + signature verification only** — no application logic, no plaintext
interpretation. Full design: [`docs/10-portal.md`](../../docs/10-portal.md).

## Run

```sh
../../scripts/run-provider.sh portal        # build if needed, defaults, start
# scripts/run-provider.sh portal --no-build # use the existing release binary
# SP_DATA_DIR=./sp-storage PORTAL_DB=./portal.sqlite cargo run --release
# SP_GATEWAY=<gateway-identity-key>  # optional: pin for a stable address
```

The script resolves every variable above (exported values win), creates the
data dir, builds the release binary if missing, and starts the provider with
owner-only file creation (`umask 077`). It also runs the `social` and `echo`
providers: `run-provider.sh social|echo`.

Prints its Nym address on startup (also `./nym-address.txt`). No inbound ports.

## API

```text
GET  /                              descriptor (HTML for browsers, JSON otherwise)
POST /obj        {object json}       -> {id, stored}
GET  /obj/<idhex>                    -> {object json}
POST /log-entry  {author,seq,obj_id,sig} -> {seq}
GET  /log/<authorhex>?since=<n>      -> {entries:[...], head}
GET  /heads                          -> {heads:[{author,seq}]}
```

Rules enforced before storage: object signature + id recomputed, log-entry
signature + continuity, referenced object must already be stored (upload
objects before log entries), forks and gaps refused.

## Sync (client-driven)

```
GET /heads  ->  diff against local heads  ->  GET /log/<author>?since=n  ->  verify + apply
```

The browser converges `LwwMap`/replicas locally; the provider never merges.

## Operations

* Back up `sp-storage/` (identity) and `portal.sqlite` (data), `chmod 600`
  the database, LUKS on the volume. Same at-rest story as `services/social/`.
* `rusqlite` pinned to 0.32 (shares `libsqlite3-sys 0.30` with `nym-sdk`'s
  sqlx — see `services/social/README.md`).

## Tests

```sh
cargo test --release   # store + route tests
```
