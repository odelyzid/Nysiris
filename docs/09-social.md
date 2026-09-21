# 9. nysiris-social: Metadata-Minimal Microblog + Encrypted DMs

> A complete hidden-service application built on `08-hidden-services.md`:
> `services/social/` (Rust provider) + `web/src/social/` (timeline UI).
> This document is also where the storage-security questions are answered.

---

## 9.1 Is SQLite a good choice for storing data securely?

**Yes, with a precise understanding of what it does and does not buy you.**

Why SQLite fits a Nym provider:

* **Embedded, no listener.** There is no database server, no port, no separate
  credentials to manage. The store is a library inside the provider process, so
  it adds zero network attack surface — the provider already binds nothing.
* **Single-file backup.** Identity + data = `sp-storage/` + `social.sqlite`.
  Copy two paths and you can rebuild the service.
* **WAL mode** gives concurrent readers for feed polls; this workload
  (tens of writes/second) is nowhere near SQLite's limits.

What SQLite does **not** do: encrypt at rest. The file is plaintext by default.
Layer the protection by adversary:

| Adversary | Mitigation | Notes |
|---|---|---|
| Disk thief / backup leak / seized VPS image | **Full-disk encryption** (LUKS) on the volume holding `social.sqlite`; `0600` file permissions | Simplest, strongest for this threat. Do this. |
| Other users/processes on the same host | `0600` perms, dedicated `nym` user, read-only containers | Contained by the deployment, not the DB. |
| The host operator themselves | **Nothing helps** — they run the process and see memory | Accept explicitly; E2E (below) is the only answer for content you hide from the operator. |
| SQL injection from mixnet input | Parameterized queries only (`params![...]`), strict hex/base64 parsing before SQL | Enforced in `store.rs`; fuzz-covered envelope parsing upstream. |

SQLCipher (encrypted SQLite) is justified only if you need the database file
itself to be opaque while the host keeps running (e.g. untrusted backups). It
adds native-build complexity and a key-management problem that is usually worse
than the disease. Prefer LUKS + `0600` unless you can state which adversary
SQLCipher stops that LUKS does not.

## 9.2 Metadata-minimal storage: what "no metadata" really means

Fully metadata-less storage is asymptotic, not achievable: to serve a feed you
must store *content + author + order*. The design goal is the floor — and every
field below it is justified or absent:

| Stored | Why it must exist |
|---|---|
| Post body, author pubkey, signature | Content + self-authenticating identity + verifiability |
| Coarse **day** (not timestamp) | Display + replay window; precise times never touch disk |
| Server sequence number | Feed pagination cursor only |
| Random 16-byte post id | Unlinkable handle (sequential ids would leak rate/count) |
| Profile name/bio | User-supplied, self-asserted, signed |
| DM recipient pubkey + nonce + ciphertext | Delivery + decryption; plaintext never exists server-side |
| DM creation time | TTL pruning only (7 days, then deleted) |

| Deliberately NOT stored | Why |
|---|---|
| IPs, Nym addresses, sender tags | Never logged, never persisted — SURB replies need none of it |
| Precise timestamps | Day buckets only |
| Follows / likes / read receipts | The feed is **global chronological**; clients filter locally. No social graph, no counters, no read tracking. |
| DM plaintext or keys | E2E (§9.4); the server holds opaque bytes |
| Delivered DMs | **Destructive read**: fetch deletes. No retention beyond delivery. |

The author pubkey is the irreducible minimum: without it there are no
signatures, and without signatures anyone can post as anyone. Timestamps
compress to day buckets. Everything else is refused at the design level, not
merely undisplayed.

## 9.3 Signature spec (byte-exact, both implementations)

Identity = ed25519 keypair; the 32-byte public key is the username.

```text
post:    b"fly-social-v1/post"    || author(32) || day_be64 || parent(16) || body
profile: b"fly-social-v1/profile" || author(32) || name || 0x00 || bio
```

* `day` = UTC day number (`unix_time / 86400`).
* `parent` = the 16-byte id of the post being replied to, or sixteen zero
  bytes for a top-level post. Fixed-size, so the no-length-prefix scheme
  holds and the body stays last. A reply is a plain post with a parent set —
  same domain, same size class, still ~one Sphinx packet.

* `day` = UTC day number (`unix_time / 86400`).
* Writes older/newer than ±2 days from the server's day are rejected
  (replay hygiene; clients re-sign with the current day).
* Weak (small-order) keys are rejected at parse — their discrete logs are
  known, so anyone could sign as them.
* Rust: `services/social/src/sig.rs`. Browser: `web/src/social/identity.ts`
  (`@noble/curves`). Same bytes, verified by cross-implementation tests.

## 9.4 E2E DM construction (byte-exact)

```text
sender:   eph = random x25519 keypair; epub = X(eph)
          shared = X(eph, montgomery(recipient_ed_pub))
receiver: shared = X(montgomery(own_ed_priv), epub)
key    = BLAKE2b-256("fly-social-v1/dm" || shared)
ct     = XChaCha20-Poly1305(key, nonce).encrypt(plaintext)
```

The ephemeral key gives per-message forward secrecy *and* keeps the sender
anonymous — the envelope carries no sender identity. Envelope on the wire:

```json
{"to":"<hex64>","epub":"<hex64>","nonce":"<hex48>","ciphertext":"<b64>"}
```

Server stores it opaquely; decryption failure (wrong key or corruption) throws
and the message is dropped. Rust side never implements this — it only relays.

## 9.5 API

```text
GET  /                               descriptor: HTML page if Accept includes
                                     text/html, else {service, version, routes} JSON
GET  /health                        {ok, seq}
GET  /feed?since=<seq>&limit=<n≤50>  {posts:[{seq,id,author,day,body,in_reply_to,sig}], next}
POST /post    {author,day,body,in_reply_to?,sig}  {seq}
GET  /post/<hex32>                   one post by id (fills thread gaps)
GET  /profile/<hex64>                {author,name,bio,day}
POST /profile {author,name,bio,day,sig}  {ok}
POST /dm      {to,epub,nonce,ciphertext} {id}
GET  /dm?for=<hex64>                 {dms:[...]}  (fetch DELETES)
```

## 9.5a Threaded replies (client-assembled)

A reply sets `in_reply_to` to the parent post's `id` (16 raw bytes as 32 hex
chars); top-level posts omit the field. The provider verifies the signature
covers the parent, rejects unknown or malformed parents with 400, binds PoW
to `parent || body`, and stores the link opaquely — it never assembles
threads. All structure is built in the browser (`web/src/social/threads.ts`):

* Timeline shows top-level posts with a reply-count pill; clicking opens a
  dedicated thread view (root on top, transitive replies chronological).
* Missing ancestors are pulled via `GET /post/<id>`, verified before merge,
  and stated honestly while absent ("Loading parent…" / "Post not yet
  available"). New syncs update the open thread.
* The verifier falls back to the pre-thread layout for old rows, so existing
  timelines keep rendering.
* Deliberately no content-hash ids (random ids avoid UNIQUE collisions on
  duplicate bodies) and no `rootId` in v1 (transitive closure is cheap).

Limits: posts ≤ 1400 bytes, names ≤ 40 chars, bios ≤ 280, DM ciphertext ≤ 1800
bytes — every request fits ~one Sphinx packet. Unsigned, stale-day, oversized,
or malformed writes get 400s; unknown routes 404.

## 9.5b Encrypted attachments (content-addressed blobs)

Posts and DMs can carry up to 3 attachments (images, text, PDF — 256 KiB
ciphertext each). Files are encrypted **in the browser** (XChaCha20-Poly1305,
random 32-byte file key, blob = `nonce(24) || ct`) and stored under their
content address `id = SHA256(blob)`; the envelope carries only metadata:

```text
AttachmentRef: {id, name, mime, size, key}
post:    ... || body || attachments → signed, key in the clear (posts are public)
dm-inner (v2): ... || body || attachments → sealed, keys end-to-end confidential
```

Key transport is the whole point: timeline posts are public, so the file key
rides in the post metadata — the blob stays confidential against the provider
and network observers, any reader can decrypt. DMs seal the entire inner
envelope to the recipient, so attachment keys never leave the E2E channel.
The provider stores opaque bytes under their hash and verifies
`id == SHA256(bytes)` on assembly; it never sees keys or plaintext
("Browser = Application, Service = Data").

Request envelopes are capped at 64 KiB, so uploads are chunked — one envelope
per 44 KiB part, each with PoW bound to `id || index || bytes`:

```text
POST /blob/part?id=<hex64>&part=<i>&of=<n>  {bytes_b64, pow?}  → {id, complete, have, of}
GET  /blob/<hex64>                           {id, bytes_b64} (404 when absent)
```

Parts stage in `blob_parts` (retried parts overwrite, mismatched `of`
rejected, staged rows older than 1 h pruned); when all `of` parts arrive they
join, hash-verify, and promote to `blobs`. Parts upload **in parallel**
(concurrency 3): every request carries a correlation `tag` that the provider
echoes in its response (`dispatch` does this for all hidden services), so the
client matches replies without sender tags — which the browser SDK does not
expose. A provider that never echoes (pre-tag deployment) makes the batch
time out once, after which the client transparently falls back to sequential
upload for that service. A 256 KiB file needs 6 parts — slow over the mixnet,
by design: attachments are occasional payloads, not a file-sync protocol. PoW is per part (sender-anonymous, like DMs) and rate
budget per blob id; blobs never expire while posts referencing them persist.

Client rules (`web/src/social/attachments.mjs` + `attachments.ts`, mirrored
in `services/social/src/attach.rs`): validate MIME + size *before*
encryption, sanitize filenames (≤80 chars, no separators/controls), sign the
canonical refs into the post/DM (stripping or swapping a ref breaks the
signature), fail closed on malformed refs, and never send a post/DM when a
blob upload fails — no dangling references. Images render blurred until
clicked; missing blobs render "Attachment unavailable", never an error.

## 9.6 Run it

```bash
# provider (no inbound ports; prints its Nym address)
cd services/social
SP_DATA_DIR=./sp-storage SOCIAL_DB=./social.sqlite cargo run --release
# SP_GATEWAY=<gateway-key>  # pin for a stable address

# back up identity + data (both needed to rebuild the service)
cp -r ./sp-storage ./social.sqlite /secure/backup/
chmod 600 /secure/backup/social.sqlite
```

Browser: open the app, find **Community**, paste the provider's address, and
the timeline loads. Identity keys live in the browser's localStorage —
app-scoped, not hardware-backed; import/export the private key hex to move
devices. Poll interval is 30 s for feed + DMs.

Abuse note: open anonymous posting invites spam. Current mitigations are
signature-required writes, strict size caps, and day-freshness. If spam appears:
per-author rate limits, invite-code-gated profiles, or small proof-of-work per
post — in that order.

## 9.7 Files

| Path | Purpose |
|---|---|
| `services/social/` | `sig.rs` (domains/verify), `store.rs` (SQLite, parent column + lookup, 4 tests), `service.rs` (routes incl. `GET /post/<id>`, 6 tests), `main.rs` (provider loop) |
| `services/social/README.md` | run/backup/operator notes |
| `web/src/social/` | `identity.ts` (keys/sign, parent-bound), `dm.ts` (E2E seal/open), `threads.ts` (client thread assembly), `ThreadView.tsx` (thread view), `Social.tsx` (timeline UI) |
| `web/test/dm-crypto.test.mjs` | E2E round-trip (skips offline) |
| `web/test/threads.test.mjs` | thread assembly, counts, gaps, cycles |
| `web/test/postCrypto.test.mjs` | post sign/verify incl. parent binding + legacy fallback (skips offline) |
