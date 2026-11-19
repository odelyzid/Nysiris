# 16. nysiris-shop: Signed Listings, Private Orders, Local Reputation

> A marketplace hidden service built on `08-hidden-services.md`:
> `services/shop/` (Rust provider), `crates/shop-format/` (wire grammar),
> and the PWA Shop tab (`web/src/adapters/driving/shop/`).
> No accounts, no carts, no payment processing, no published scores.

---

## 16.1 Scope and trust boundaries

The shop is a **bulletin board plus a private per-order mailbox**, not a
custodian. It never holds money, shipping addresses, or a seller score. The
provider can refuse to store a signed write or go offline; it cannot forge one,
because every write is ed25519-signed by the key that owns it, and clients
re-verify what they read.

| Party | Can do | Cannot do |
|---|---|---|
| Seller | Publish/replace/delete their listings, accept/decline/fulfil orders | Edit another seller's listing, move someone else's order |
| Buyer | Reserve stock with a signed order, cancel before fulfilment, message, review once after fulfilment | Read another buyer's order book, review an unfulfilled order |
| Provider | Store and relay signed rows, enforce stock/state transitions | Forge a signature, silently change a price without a newer signed version, publish an authoritative score |

The provider is still a **privacy adversary** for metadata: it sees which
public keys transact, how many units, and coarse shipping-day activity. Use the
social service's encrypted DM dead-drop for addresses and logistics
(`09-social.md` §9.4), and treat order notes/threads as coordination only.

## 16.2 Metadata-minimal storage

SQLite is embedded, single-file, WAL mode, with no network listener — the same
operational reasoning as the social service (`09-social.md` §9.1). The provider
forces owner-only (`0600`) permissions on the database and its WAL/SHM sidecars
at startup. Back up `sp-storage/` (identity = the Nym address) and
`shop.sqlite` together.

| Stored | Why it must exist |
|---|---|
| Listing id (random 16 bytes), seller key, version, price, stock, currency, title, description, signature | Content, self-authenticating ownership, replay-safe updates |
| Coarse **day** | Freshness window and display; precise times never touch disk |
| Order id (random 16 bytes), listing id, buyer key, seller key, quantity, signed price/version snapshot, short note, state, signature | Fulfilment, stock accounting, frozen sale terms, participant-scoped reads |
| Signed transition events (from/to state, actor, coarse day, note, signature) | Client-replayable state proof; the provider cannot invent a status |
| Order creation time | Ordering only |
| Order messages: author, coarse day, body, signature | Private buyer/seller coordination |
| Reviews: order id, listing id, seller key, buyer key, rating, body, signature | Raw evidence for a **client-computed** reputation |

Deliberately absent: IPs, Nym addresses, sender tags, precise timestamps, view
counters, carts, follow graphs, payment credentials, shipping addresses, and
any server-side aggregate score. A review is one row per fulfilled order; there
is no way to delete a bad review without deleting the order's history.

At-rest protection is volume encryption (LUKS) plus `chmod 600 shop.sqlite`.
SQLCipher adds native-build and key-management complexity without answering a
threat LUKS does not (the same trade-off as `09-social.md` §9.1).

## 16.3 Signature spec (byte-exact, both implementations)

Identity = ed25519 keypair; the 32-byte public key is the account. Domains are
`fly-shop-v1/*` and are immutable release contract.

```text
listing:       b"fly-shop-v1/listing"        || seller(32) || day_be64 || id(16)
               || version_be64 || price_be64 || stock_be32 || currency(3)
               || title || 0x00 || description
listing-del:   b"fly-shop-v1/listing-delete" || seller(32) || id(16) || day_be64
order:         b"fly-shop-v1/order"          || buyer(32)  || day_be64 || listing(16)
               || id(16) || qty_be32 || price_be64 || version_be64 || note
order-status:  b"fly-shop-v1/order-status"   || actor(32)  || day_be64 || order(16)
               || status(1) || note
orders-read:   b"fly-shop-v1/orders-read"    || for(32)    || day_be64
order-message: b"fly-shop-v1/order-message"  || author(32) || day_be64 || order(16) || body
review:        b"fly-shop-v1/review"         || author(32) || day_be64 || order(16)
               || seller(32) || rating(1) || body
```

* `day` = UTC day number (`unix_time / 86400`), accepted within ±2 days.
* Fixed-size fields come first; the variable payload is last; no length
  prefixes. `title`/`description` are NUL-free, so the listing separator is
  unambiguous.
* `price` is an integer count of **minor units** (cents) and `stock`/`qty` are
  u32. No float ever crosses the wire.
* An order signs the listing's `price` and `version` at reservation time. The
  store refuses an order whose snapshot no longer matches the current listing,
  and the signed snapshot is returned with the order, so a later listing update
  cannot retroactively change what a buyer agreed to.
* The signed `stock` is the seller's **maximum** inventory and is never
  rewritten by orders. The provider derives `available = stock − units held by
  reserved/accepted/fulfilled orders` on read, so a listing signature stays
  valid while stock moves.
* `currency` is exactly three ASCII uppercase letters, not a display string.
* Listings are **versioned**: an update must carry a strictly greater
  `version`, so replaying an old signed listing cannot lower the price or roll
  stock back. A seller cannot take over another seller's listing id.
* `orders-read` is proof of possession for the private order book. Buyer and
  seller keys are public (they sign every write), so an unauthenticated
  `GET /orders` would expose who bought what.

Mirrors: `crates/shop-format/src/sig.rs` and `web/src/domain/shop.ts`.
Fixed cross-implementation vectors live in both test suites; `./build.sh check`
also compares the constants and domains (`scripts/check-constants.mjs`).

### Proof-of-work preimages

When the provider advertises `pow_bits > 0`, each write also carries a proof
binding `(key, SHA256(preimage))`:

```text
listing:  id(16) || version_be64 || price_be64 || stock_be32 || currency(3)
          || title || 0x00 || description
delete:   id(16)
order:    listing(16) || id(16) || qty_be32 || price_be64 || version_be64 || note
status:   order(16) || status(1) || note
message:  order(16) || body
review:   order(16) || seller(32) || rating(1) || body
```

PoW and the per-key daily rate budget are spam backstops, not trust: a valid
proof proves work, never honesty.

## 16.4 Order lifecycle and stock

```text
                 seller accepts
  reserved ───────────────────────▶ accepted ─── seller fulfils ──▶ fulfilled
     │                                  │
     │ seller declines                  │ buyer cancels
     ▼                                  ▼
  declined                           cancelled
     (both release availability; fulfilled keeps units consumed)
```

* `POST /order` is buyer-signed and **atomic**: availability is the signed
  `stock` minus the sum of quantities held by reserved, accepted, or fulfilled
  orders, computed inside the same SQLite transaction that inserts the order,
  so an oversell is refused. The signed listing row is never mutated.
  A seller cannot order their own listing; the store rejects `buyer == seller`
  so self-purchases cannot bootstrap a self-review.
* The signed price/version snapshot is checked against the listing inside the
  same transaction. A buyer using a stale cached catalog gets a rejection
  instead of silently agreeing to a newer price; refreshing the listing and
  re-signing is required.
* Transitions are role-scoped. A buyer cannot accept or fulfil; a seller cannot
  cancel; terminal states never revive. Declining or cancelling releases the
  reservation exactly once because only open/fulfilled states consume stock.
  Every accepted transition stores its signed proof; clients replay the chain
  from `reserved` and reject an order whose reported state is not the chain's
  end state.
* Fulfilment consumes the reservation permanently. Orders are not refunded by
  the protocol — settlement and refunds happen between the parties.
* A seller changes their maximum stock by publishing a **strictly newer
  version**; that re-signs the listing and resets availability against the
  order history. A lower version is refused, so an old listing cannot roll
  price or stock back.
* Only a **fulfilled** order may be reviewed, once, by its buyer. The review
  signs the order id **and** the seller key, so a provider cannot copy a rating
  onto another seller's profile. Reviews also refuse `author == seller` as a
  second line of defence.
* If a validly signed write passes signature/PoW but is refused by the store
  (stale version, duplicate review, self-order, …), its daily rate slot is
  refunded. Replaying a public signed request therefore cannot lock the signer
  out for the rest of the day.

## 16.5 Reputation is computed locally from raw reviews

The provider stores and serves raw signed reviews. It does **not** publish a
score, and `GET /reviews/<seller>` returns the rows plus a convenience
aggregate covering **all** of that seller's reviews, not only the returned
page. Clients re-verify each review signature against the buyer key and the
signed seller key, then recompute the summary themselves from every page they
load (bounded to keep mixnet traffic sane), so a provider cannot inflate,
bury, or reassign a rating unnoticed.

`shop_format::review::summarize` (mirrored in `web/src/domain/shop.ts`)
ignores out-of-range ratings and keeps an exact integer sum. The UI renders
`sum / count` to one decimal. This is evidence, not a trust verdict: five
reviews from five fresh keys is not the same as five hundred from long-lived
keys. Combine it with the portal's standing model (`10-portal.md` §10.5).

## 16.6 API

```text
GET  /                                       service descriptor (JSON or HTML)
GET  /health                                 {ok, listings, orders}
GET  /listings?offset=&limit=&q=&seller=     active listings
GET  /listing/<hex32>                        one listing (also inactive)
POST /listing                                signed create/update (versioned)
POST /listing/<hex32>/delete                 signed soft-delete
POST /order                                  buyer-signed reservation
GET  /orders?for=<hex64>&day=&sig=<hex128>   private to buyer/seller
POST /order/<hex32>/status                   signed state transition
POST /order/<hex32>/message                  participant-only thread (500-message cap)
GET  /order/<hex32>/messages?for=&day=&sig=&offset=&limit=  older thread pages
POST /review                                 one buyer review per fulfilled order
GET  /reviews/<hex64>?offset=&limit=         raw signed reviews
```

Reads are plain GETs; writes are JSON with `sig` and, when required, `pow`.
Unsigned, stale-day, wrong-party, and out-of-bounds writes are rejected before
storage. Listing objects carry the signed `stock` **and** derived `available`;
clients must verify signatures over `stock` and order against `available`.
Soft-deleted listings stay resolvable for past orders but disappear from
browse and refuse new orders. Order objects carry `status_events`, the signed
transition chain; clients replay it (`verifyStatusChain`) and reject any state
the parties did not sign. They also carry the signed price/version snapshot
plus the latest 20 thread messages and a cursor for older pages; a thread is
capped at 500 signed messages. The paginated thread read uses the same signed
proof of possession as `/orders` and refuses non-participants.

## 16.7 Privacy rules for buyers and sellers

* **Never put a shipping address in a listing, order note, or order thread.**
  Those fields are stored server-side and visible to at least the provider.
  Trade addresses through the social service's sealed DM dead-drop, or another
  end-to-end channel.
* Order notes and messages are short coordination text. Threads are readable
  only through signed, participant-scoped order reads; reads are bounded in
  pages so a long thread cannot be pulled back in one response.
* Reviews are public and permanent. They can contain text, so write nothing
  personal.
* Mixnet metadata is still metadata: repeated transactions between two public
  keys are linkable by the provider. Rotate identities for unrelated trades if
  that matters to you.

## 16.8 Run it

```sh
cd services/shop
SP_DATA_DIR=./sp-storage SHOP_DB=./shop.sqlite cargo run --release
# SHOP_POW_BITS=16 SHOP_RATE_PER_DAY=200  # optional spam backstops
# SP_GATEWAY=<gateway-identity-key>        # optional: stable address
```

The provider prints its Nym address and writes `nym-address.txt`. Paste that
into the PWA's **Shop** tab. No inbound port is opened; replies go over SURBs.

## 16.9 Files and tests

| Path | Role |
|---|---|
| `crates/shop-format/` | Wire grammar: signatures, state machine, PoW preimages, review arithmetic, limits |
| `services/shop/` | Nym provider: `service.rs` routes, `store.rs` SQLite, `main.rs` transport |
| `web/src/domain/shop.ts` | Byte-exact client mirror and local verification |
| `web/src/adapters/driving/shop/` | PWA Shop tab: browse, sell, orders, threads, reviews |
| `web/test/shop.test.mjs` | Cross-implementation vectors, preimage layouts, state rules |
| `scripts/check-constants.mjs` | Fails if Rust and web domains/limits drift |

```sh
cargo test -p shop-format            # fast, nym-free grammar + vectors
cd services/shop && cargo test      # store, routes, PoW/rate gating
node --test web/test/shop.test.mjs  # browser mirror
```
