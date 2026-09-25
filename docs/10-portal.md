# 10. Portal Layers: Data, Replication, Discovery, Reputation

> Design note + implementation record for the Osiris-style serverless portal.
> The non-negotiable principle from `08-hidden-services.md` §8.6 holds for
> everything below: **browser = application, service = data**.

---

## 10.1 The principle, restated for portal scope

A portal is a *view* the browser computes, not a place the browser visits:

* Services store **opaque signed bytes** and verify signatures. They never
  execute logic on behalf of users, never learn who asked (SURB replies), and
  never see plaintext they weren't meant to (E2E payloads stay sealed).
* The browser holds **keys, identity, follows, reputation, and rendering**.
  Fetched bytes render in `sandbox=""` iframes or as app UI over parsed data.
* Protocol support is explicit and versioned: the client speaks exactly the
  envelope/object types in `portal-data`, nothing else.

The windowed UI (`web/src/ui/`) is the physical expression of this: the main
view is the portal context (page + Social), while transport machinery
(Connection, Messages, Fetch, Log) lives in closable panels. New portal
features arrive as **toolbar entries + panels + pure-logic modules**, never as
service-side code running in the browser.

## 10.2 Layer map

| Layer | Crate / module | Status |
|---|---|---|
| Data model | `crates/portal-data` (objects, logs, LWW-map) | ✅ 4 tests |
| Sync core | `crates/portal-replication` (heads, wants, verified apply) | ✅ 4 tests + 5 golden wire vectors |
| Provider | `services/portal-provider/` (object/log store, 6 routes) | ✅ 5 tests |
| Replication | client-driven gossip over the routes above | provider side ✅, browser TS port ✅ (`web/src/social/portalSync.ts` + `portalVerify.ts` + `portalSyncIo.ts`) |
| Discovery | signed invite links + local contacts + URI-bar binding | ✅ |
| Reputation | client PoW + web-of-trust + local scores | ✅ (this section: PoW, local scores, rate limits) |

## 10.6 Discovery: invite links (implemented)

Discovery starts — and, for now, ends — with **signed introductions**:

```text
link = "nym://<id>.<enc>@<gw>#invite=<base64url(JSON)>"
signed = domain || svc_identity || svc_encryption || svc_gateway || inviter || note
```

* `crates/nym-hidden-service/src/invite.rs`: sign/verify/compact-codec, including
  a cross-implementation test (a TypeScript-signed vector verified in Rust).
* Browser: `signInvite`/`verifyInvite` in `web/src/social/identity.ts` (byte-exact
  mirror), pure codec in `hiddenService.mjs`, `parseInviteLink()` splitting
  address + path + invite.
* URI bar: pasting an invite link fetches the service *and* raises a banner
  showing introducer + note. Accepting **verifies the signature first**, then
  saves a petname into the local-only Contacts panel (`web/src/ui/`).
  Bait-and-switch (invite naming another service) is refused twice:
  client-side shape check and signature verification.
* The fragment never goes on the wire — invites authenticate the introducer to
  the recipient only. Notes are capped at 140 chars so links stay small.

What this deliberately omits (per `05-security.md` §5.7): any global directory,
DHT, or ambient peer discovery. Contacts never leave the machine.

## 10.3 `portal-data`: content-addressed signed objects

Every portal datum is an **Object**:

```text
signing_bytes = b"fly-portal-v1/object" || author(32) || kind || 0x00 || payload
id            = SHA256(signing_bytes || sig)
```

* `kind` is namespaced text (`post`, `profile`, `dm-chunk`, `wiki/…`),
  charset `[a-z0-9/_-]`, max 64 chars. Unknown kinds are *stored* (any peer can
  hold bytes) but only *rendered* if the client knows the kind.
* `id` binds author + kind + payload + signature: tampering any byte changes
  the id, so references (feeds, replies, log entries) are self-checking.
* JSON form carries hex ids/keys and base64 payloads, matching the envelope
  conventions of `nym-hidden-service`.

**Append-only logs** order one author's objects: each entry binds
`(author, seq, obj_id)` under `fly-portal-v1/log-entry`. Ingest rule: `seq`
must equal the log length — forks (two entries, same seq) are rejected, never
merged. A log is a portable, replayable identity history.

**LWW-map** converges shared mutable state (profiles, wiki pages, pin lists)
without coordination: each key holds the value with the greatest
`(day, author, obj_hash)` dot. Merge is union + max, hence commutative,
associative, and idempotent — any two replicas that exchange entries converge.
Wall-clock dependence is limited to coarse days, consistent with the metadata
policy (`09-social.md` §9.2).

Deliberate omissions: no timestamps below day granularity, no global sequence,
no delete propagation (tombstones are just newer values), no access control
beyond signatures. Spam and Sybil are *not* solved here — see §10.5.

## 10.4 Provider and replication (implemented)

The portal provider stores objects by id, appends to logs after verifying
signatures and continuity, and answers `GET /obj/<id>`, `GET /log/<author>?since=`,
`POST /obj`, `POST /log-entry` — data + verification only, via the existing
`HiddenService::dispatch` harness. Replication is client-driven gossip:
browsers exchange want-lists/have-lists through SURB replies and converge
LWW state locally. The serve shapes for the two read routes
(`GET /heads`, `GET /log/<author>?since=`) live in
`crates/portal-replication/src/serve.rs` and are pinned byte-for-byte by the
golden vectors in `crates/portal-replication/tests/golden.rs`, which the
browser TypeScript port mirrors exactly: `web/src/social/portalSync.ts`
parses the same `GET /heads` / `GET /log/<author>?since=` JSON, reproduces
`entry_bytes` and object signing bytes byte-for-byte, computes wants as the
local log head per author, and applies batches atomically after verifying
signatures (`web/src/social/portalVerify.ts`). The browser port is a
read-side replica only — it never merges forks, enforces continuity, and
persists under the frozen `fly.portal.sync.v1` key. Traffic rides
`fetchNym` (serialized) / `fetchNymParallel` (tag-correlated) NYM requests
via `web/src/social/portalSyncIo.ts`, surfaced in the Portal panel
(`web/src/ui/PortalSync.tsx`). Discovery starts
where we already are — invite links
(`nym://` URIs + petnames) and URI-bar binding — before any ambient mechanism.

## 10.5 Reputation and spam (implemented)

Three layers, each insufficient alone, strong together:

* **Client-side PoW** (`portal-reputation/src/pow.rs`, `web/src/mixnet/pow.mjs`):
  `SHA256(domain || author || payload_hash || nonce)` with N leading zero
  bits. Binding author + payload hash makes proofs non-replayable across
  authors or messages; verification is one hash. Providers advertise difficulty
  in `GET /` (`pow_bits`, 0 = off, capped at 32 so no provider can demand
  years of CPU). The browser proves only when required, after reading the
  descriptor. PoW prices spam; it does not stop a funded attacker.
* **Local reputation** (`portal-reputation/src/reputation.rs`,
  `web/src/mixnet/reputation.mjs`): scores from first-hand observation only
  (valid/invalid signatures, duplicates, undecryptables, equivocation), with
  clamping and 30-day decay. Never fetched, never published. The timeline
  verifies every post signature on receipt — forgeries never render — and
  shows the local standing per author.
* **Provider rate limits** (`portal-reputation/src/rate.rs`, wired into both
  providers): per-author daily budgets (`PORTAL_RATE_PER_DAY`,
  `SOCIAL_RATE_PER_DAY`, default 500; DMs bucketed per *recipient* so one
  victim's mailbox can't be flooded). In-memory by design (backstop, not
  accounting); 429 on exhaustion.

Enforcement map: `POST /obj` and `/log-entry` (portal) and `/post`, `/profile`,
`/dm` (social) check PoW-then-budget before touching storage. Unsigned,
under-proofed, or over-budget writes get 400/429.
