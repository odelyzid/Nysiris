# 5. Security Analysis & Recommendations

> Section [4] of the original brief: tagging, timing, SURB reuse/hoarding, exit
> trust, and the rest. This section uses Nym's own threat-model vocabulary so
> the analysis matches the network's documented guarantees.

---

## 5.0 How to read this section

Two framing tools make the rest precise.

**Four actors, by vantage point** (Nym's taxonomy):

| Actor | Vantage | Observes | Cannot observe |
|---|---|---|---|
| **L1** Public observer | Reads public/out-of-band data | Whatever your app publishes | Everything else |
| **L2** Destination | *Is* the server you talk to — **the primary adversary** | Your exit gateway's IP, exact arrival times, full request contents | Only what you never send |
| **L3L** Local network observer | Wi-Fi / ISP, knows your IP | Constant-size packets at a Poisson rate; *that* you use Nym | Destination, volume, activity |
| **L3G** Global network observer | Sees both ends and all hops | Per-packet flow correlation across the whole path | TLS contents |

**Two unlinkability properties**:

* **P1 — request-identity unlinkability:** the adversary cannot attribute a
  request to *you*.
* **P2 — request-request unlinkability:** the adversary cannot tell that two
  requests came from the *same* client.

They are asymmetric: a P1 failure implies P2, not vice versa. Most systems land
in a fragile **pseudonymous profile** where **one attributed request retroactively
attributes the whole profile**.

**Two layers** (the category error to avoid):

* **Layer 1, transport** — who can see that you are talking, and to whom.
  (mixnet, dVPN). Buys identity separation and in-transit timing protection.
* **Layer 2, baseline hygiene** — what your *request pattern* leaks to the
  destination. This is **your** responsibility, not the transport's.

> **The central point.** Mixing delays and cover traffic reshape what a network
> observer (L3L/L3G) can infer. They change nothing about what the destination
> (L2) sees once traffic arrives. Transport alone is never the whole answer.

Three linkage vectors, referenced throughout: **V1** session state (client IP,
connection/session identifiers), **V2** timing (arrival times; packet
timing/size/volume), **V3** content (endpoints, parameters, payload).

---

## 5.1 Tagging attacks

A *tagging attack* aims to make a packet recognisable at a hop that is **not**
the hop that applied the mark. If successful it collapses the mix: the adversary
links entry and exit and recovers the route.

### 5.1.1 Bit-level tagging ("xor-and-detect")

**Mechanism.** A malicious node flips a chosen bit in the payload (or header),
then a later colluding node looks for that bit.

**What Nym does.** The format is built to defeat this:

| Target | Protection | Effect on tampering |
|---|---|---|
| Routing info (β) | **HMAC-SHA256 truncated to 16 B (γ)** | Any change to β fails the MAC → packet dropped |
| Payload (δ) | **Lioness wide-block cipher** (BLAKE2b + ChaCha) | Changing *any* byte randomises the *entire* plaintext |
| Padding delimiter | Lioness wide-block | The `0x01` end-of-message marker cannot be targeted surgically |
| α (per-hop key) | **Per-hop blinding** `α_{i+1} = b_i · α_i` | A node cannot recognise later the α it forwarded |

Because the payload is a wide-block cipher, a flip does not produce a localised
change the adversary can locate downstream — it produces garbage that fails the
leading-zero check on recovery. Tag-and-detect therefore fails, and repeated
tagging is detectable as corruption.

**Residual risk.** This defends the *format*. It does not stop **traffic-level**
tagging (delay, drop, duplicate, reorder), which is a correlation attack, covered
in §5.2.

### 5.1.2 The Kuhn et al. padding attack

**Mechanism.** Kuhn et al. showed that *deterministic* padding in Sphinx's final
destination block lets a malicious mix recognise which hop is last.

**What Nym does.** The final hop's block uses **random padding**, not zeros.
This is implemented and commented in
[`crates/sphinx-core/src/header.rs`](../crates/sphinx-core/src/header.rs)
(`build_final_hop`: "Random padding, not zeros: Nym's mitigation for the Kuhn et
al. attack"). This is a genuine divergence from the 2009 paper.

### 5.1.3 Replay-based tagging

**Mechanism.** Record a packet at one hop, replay it later at another, and match.

**What Nym does.** Each hop's expanded shared secret yields a **replay tag**
(`h_τ`), which nodes feed into a replay filter; duplicated packets are dropped.
This is derived in `ExpandedSharedSecret::replay_tag()`.

**Residual risk.** Replay protection is only as strong as each node's filter
implementation and memory budget. Do **not** rely on the mixnet for
application-level replay protection: include your own nonces/message ids, and
treat late or duplicated application messages as untrusted. Our SURB design
already enforces **single use** (§5.3).

### 5.1.4 n−1 and route-capture

**Mechanism.** If an adversary controls *n−1* of the 5 hops it can correlate the
route. The strongest case is controlling **entry and exit**: it then sees the
client's IP *and* the destination.

**What Nym does.** Random per-epoch selection across three mix layers, bonded
and economically-staked nodes, and independent per-hop delays raise the cost.
Nym does not claim a formal guarantee against a well-resourced L3G.

**Recommendations.**
* Do not pin **both** entry and exit to the same operator.
* Re-select paths per message/session; avoid long-lived fixed paths.
* Prefer **end-to-end** (pure mixnet) mode where possible: with no exit, the L2
  category error disappears entirely.
* Treat any single-node trust assumption as unsafe by construction.

---

## 5.2 Timing & traffic analysis

**Mechanism.** Correlate packet timing/volume between the two ends of a path.
L3G is the actor this threatens; it is the *only* actor mixing addresses.

### 5.2.1 What the mechanisms actually buy

| Mechanism | Value |
|---|---|
| **Per-hop randomised delay** (≈15 ms mean per node, 5 hops) | Order out ≠ order in; breaks FIFO correlation |
| **Poisson sending** (client side) | Decorrelates send time from user activity |
| **Cover traffic** (~5 loop packets/s) | Fills the gaps so real packets are not the only traffic |
| **Fragmentation across paths** | A message's packets take independently-selected routes |

Latency is the *mechanism*, not a bug: "removing the delay removes the
protection, so there is nothing to tune."

### 5.2.2 Attacks and residuals

* **Long-lived / bulk flows.** A sustained flow gives an L3G a large correlated
  sample. Nym states plainly that **how far bulk transfers can be correlated
  over time is an open question**, and that the mixnet is strongest for *small,
  independent* messages. **Do not use mixnet mode for bulk transfer.**
* **Repeated contact / intersection.** Recurring contact with the same
  destination accumulates evidence. Layer-2 hygiene (§5.5) is the answer.
* **Fixed exit is a linking key (P2).** Requests through one exit stay linkable
  to each other *at the destination*. **Rotate the exit per request** to restore
  P2; pinning an exit (`preferredIpr`) trades P2 for predictability.
* **Startup/bootstrap timing.** The first topology fetch is clearnet HTTPS; on a
  network where "uses Nym" is itself sensitive, that bootstrap is visible to L3L.

### 5.2.3 Timing hygiene (Layer 2) — required, not optional

Transport cannot fix destination-facing timing. You owe:

* **Randomised request scheduling** — jitter requests; do not fire on a
  user-visible milestone in lockstep.
* **Decoys / overlapping requests** — issue cover requests so real ones are not
  isolated.
* **Batching** — collapse bursts into fewer, less informative requests.

Nym provides `nym-swizzle` for exactly these primitives; treat it as mandatory
for sensitive workloads.

---

## 5.3 SURB attacks (reuse, hoarding, DoS)

SURBs are **single-use reply blocks**: a pre-built return Sphinx header plus the
per-hop payload keys, encrypted so the recipient cannot read the route. They are
what let a provider reply **without ever learning the client's address**.

### 5.3.1 SURB reuse

**Mechanism.** Reusing a SURB lets a recipient replay replies and correlate them,
and destroys forward secrecy for that reply.

**What we do.** `SurbMaterial` is documented single-use and provides no replay
protection of its own: **the client must record used identifiers and refuse to
accept a second reply for the same SURB.** Never give the same SURB to two
parties.

**Recommendations.**
* One SURB, one reply. Track `identifier`s and reject duplicates.
* Purge used and expired SURBs eagerly.
* Never publish SURBs (e.g. in a directory) — they are single-use capabilities.

### 5.3.2 SURB hoarding (the documented active attack)

**Mechanism.** A malicious receiver hoards SURBs and sends them all back
simultaneously, attempting to correlate traffic patterns at the sender's gateway.
Nym's own docs describe this and note it **requires active participation** (not
passive observation) and yields **limited information even if successful**.

**Recommendations.**
* Attach the **minimum** number of SURBs (enough for the expected reply size).
* Rate-limit **replenishment** requests; never grant unbounded SURB refills.
* Do not bundle SURBs when you do not expect a reply.
* Keep cover traffic on so the return burst is not the only signal.

### 5.3.3 SURB validity and staleness

SURB validity is tied to **key rotation (~24 epochs ≈ 25 h)**; reply keys expire
after ~24 h independently. Stale SURBs must be purged and refreshed, or replies
silently fail.

### 5.3.4 SURB DoS / reply amplification

**Mechanism.** A client attaches many SURBs, or legitimately triggers many
replies, to exhaust a provider's shared send budget (~50 real packets/s).

**Recommendations.**
* Cap replies per request and per sender-tag per window.
* Size replies to a single packet where possible; use the Stream module for bulk.
* Monitor queue depth; run multiple provider clients when the budget saturates.

### 5.3.5 Sender tags

Tags are **random and unlinkable** to the client's address; they only let the
service group SURBs from one conversation. Rotate tags between conversations to
limit service-side linkage.

---

## 5.4 Exit Gateway trust

The exit is the last Sphinx hop for clearnet traffic. It is the one node that
sees your **destination**.

### 5.4.1 What the exit sees (and does not)

| | IP Packet Router (mix-fetch / mix-tunnel / smolmix) | Network Requester (SOCKS) |
|---|---|---|
| Sees | Destination **IP and port** | Destination **hostname and port** (with `socks5h://`); an IP otherwise |
| DNS | Never learns the hostname | Resolves DNS for you (sees the name) |
| Sender identity | **Not seen** (P1 holds) | Sees **your Nym address** unless anonymous replies are enabled |
| Payload | Only ciphertext for `https://`/`wss://` | Same |

**Key facts.**
* The exit sees destinations but **not senders** — Sphinx layering means it
  cannot determine who sent a packet.
* For a **fixed** exit, requests remain **linkable to each other at the
  destination (P2 fails)**. Rotate the exit per request to restore P2.
* With plain SOCKS (no anonymous replies) the Network Requester additionally
  receives your **Nym address**, which is stable and names your entry gateway.
  Use `--use-anonymous-replies` (standalone) or the SURB path.
* IPR-backed browser packages (`mix-fetch`, `mix-tunnel`, `mix-websocket`,
  `mix-dns`) never expose your hostname to the exit.

### 5.4.2 What a malicious exit can do

* Log and analyse **every clearnet destination** you contact.
* Read and **modify non-TLS payloads**; `http://` and `ws://` are fully exposed.
* Refuse service, fingerprint you, and **attempt timing correlation with an
  entry it also controls**.
* It **cannot** read TLS-protected contents, and it **cannot** attribute packets
  to you without colluding with your entry.

### 5.4.3 Recommendations

* **Always use TLS** — `https://` and `wss://`, never `http://`/`ws://`. Over TLS
  the exit handles only ciphertext.
* **Never rely on the mixnet for application-layer anonymity.** Cookies, logins,
  API tokens and request contents reach the destination as you sent them.
* **Rotate exits per request** for unlinkability; pin only when the operator or
  jurisdiction matters, and accept the availability trade-off.
* **Never pin the same operator** as both entry and exit.
* **Check the exit policy** first: it is a single deny list, identical across all
  operators, and an individual operator cannot vary it. If your port is not
  permitted, no client-side change helps — the route is governance.
* **Prefer end-to-end.** If both ends run Nym, there is no exit at all and the
  L2 adversary does not exist. This is the strongest position the network offers.
* **Legal/operational:** running an *exit* exposes your IP to abuse complaints.
  Hosting a *service* (§3) does not require running one.

---

## 5.5 Application-layer identity & content (V1/V3) — the biggest real risk

For most applications the destination (L2) is the primary adversary, and no
transport hides a login, a session cookie, a stable API token, or a unique
account id. This is where real de-anonymisation usually happens.

**Recommendations.**
* No cross-session correlators: no persistent cookies, no stable tokens, no
  device fingerprints sent to routed destinations.
* **Short-lived connections**; no connection reuse across identities.
* **Request-shape discipline:** pad, batch, and decoy requests
  (`nym-swizzle` primitives).
* Separate identities per context; never mix a known account with an anonymous
  one through the same exit.
* Remember the asymmetry: **one attributed request attributes the whole
  pseudonymous profile.** Treat slips as total, not partial, failures.

---

## 5.6 Client-side risks (browser, extension, Android)

| Risk | Detail | Mitigation (implemented where noted) |
|---|---|---|
| **Direct-path leak** | A request to a routed host bypasses the mixnet | `web/src/mixnet/leakGuard.ts` wraps `fetch`/`XHR`, logs always, **fails closed in dev** |
| **Unroutable traffic** | Cross-origin iframes, vendor SDKs, `sendBeacon`, `EventSource`, `<img>`/`<script>`, third-party `WebSocket`s bypass your code | Documented; drop or proxy those integrations |
| **CSP misconfiguration** | Missing `worker-src 'self' blob:` blocks the WASM worker; missing bootstrap host fails with an unrelated error | `web/index.html` provides a correct CSP template |
| **Supply chain** | The WASM/worker chunk is large and third-party | Pin Nym package versions; `script-src 'self'`; no remote code |
| **Key storage (web)** | Messaging SDK keeps identity in **IndexedDB** — app-scoped, **not hardware-backed** | Documented; clear IndexedDB to rotate identity |
| **Key storage (social identity)** | DM identity in `localStorage` readable by any origin script | **`NysirisKeystore` Capacitor plugin**: AES-256-GCM keys held in the hardware-backed Android Keystore, only ciphertext in SharedPreferences (`web/src/social/keystore.mjs`, `NysirisKeystorePlugin.java`); localStorage stays as fallback cache |
| **Key storage (Android)** | IndexedDB is not Keystore-backed | `android:allowBackup="false"`; social identity via the Keystore plugin above |
| **Cleartext** | An accidental `http://` request leaks to the exit and the network | Android `usesCleartextTraffic="false"` + `network_security_config.xml`; use TLS everywhere |
| **Background suspension** | Android Doze/App Standby suspend a long-lived tunnel | Foreground service with notification, or foreground-only + reconnect; one-shot WASM tunnel needs a page reload |
| **Extension surface** | MV3 service worker is ephemeral; extension has broad host permissions | Run the tunnel in an **offscreen document**; keep permissions minimal |
| **Device compromise** | Screen capture, memory scraping, malicious keyboard | Out of scope for any network privacy tool — assume an owned endpoint is lost |
| **Clipboard / recents** | Addresses and messages can leak via OS surfaces | Addresses are public; for message content consider `FLAG_SECURE` |

> **Endpoint security dominates.** No mixnet protects a compromised device.
> State this in your threat model rather than implying otherwise.

---

## 5.7 Infrastructure & network risks

| Risk | Mechanism | Mitigation |
|---|---|---|
| **Sybil / topology capture** | Register many nodes to gain path share | Bonding cost, per-epoch random selection; **verify the signed topology and pin the signing key** |
| **Topology poisoning** | Compromised `nym-api` serves attacker nodes | Signature verification + pinned network key; do not trust an unverified topology |
| **Address enumeration** | A public directory would let anyone enumerate services | **No discovery system by design**; distribute addresses out of band |
| **DoS at the entry** | Flood the gateway; cover traffic amplifies cost | Gateway rate limits and credential checks |
| **Bandwidth theft** | Free-riding on paid capacity | **zk-nym** credentials: double-spend protection, unlinkability, rerandomisation |
| **Stale topology/keys** | Epoch rotation invalidates routes and SURBs | Re-fetch per epoch; purge stale SURBs |
| **Gateway disappearance** | The gateway key is *in the address*, so its loss breaks every copy | Run your own gateway for stability (§3.3); keep provider storage backed up |

---

## 5.8 Performance, cover traffic, and honest limits

**Defaults (configuration constants, not measurements):**

| Stream | Default | Rate |
|---|---|---|
| Real packets | 1 per 20 ms | ~50/s |
| Loop cover packets | 1 per 200 ms | ~5/s |
| **Total** | | **~55/s**, on the order of **~100 KB/s** |

**Consequences.**
* **Idle costs the same as busy** — cover traffic means an idle client pays
  nearly the full bill, continuously.
* **Capacity is a shared budget** — every reply to every client competes for the
  ~50 real packets/s.
* **Disabling pacing is a privacy downgrade.** `disableCoverTraffic` and
  `disablePoissonTraffic` cut bandwidth, but they weaken you against the
  **network observer (L3G)** — the only actor mixing protects you from. Expose
  these switches only with an explicit warning.
* **Latency is the product.** Expect hundreds of milliseconds to seconds per
  request. Interactive and bulk workloads are out of scope for mixnet mode.

**Fit check** (from Nym's own guidance): *yes* for page fetches, API calls,
transactions, small repeated requests, messaging between two Nym clients;
*no* for large downloads, full chain sync, video/voice, real-time gameplay, or
anything needing sub-second round trips.

**Bulk transfer is doubly weak:** it is the slowest workload *and* the one the
anonymity protection covers least well (long correlated flows). Use dVPN mode
when you need rate, understanding it provides **no in-transit timing protection**.

---

## 5.9 "Nym Sphinx" vs the academic paper — security-relevant deltas

| Aspect | Paper (2009) | Nym (production) | Security consequence |
|---|---|---|---|
| Group | Bilinear, pairings | **Curve25519 / X25519** | Security rests on CDH, not a bilinear group |
| Padding | Deterministic | **Random final-hop padding** | Mitigates Kuhn et al. |
| Versioning | none | **3 version bytes per routing block** | Enables agile upgrades; version-gated processing |
| Replay | `h_τ` defined | **Replay tag + node filters** | Replay defence depends on filter implementation |
| Reply | unrelated | **SURB with per-hop key seeds** | Compact SURBs; must be treated as single-use |
| Framing | one packet | **chunking, acks, cover, framing** | Real system surface exceeds the paper |
| Payload cipher | stream cipher | **Lioness wide-block** | Bit-flipping and padding-targeting defeated |

Full byte layout and algorithm: [`02-addressing-and-routing.md`](02-addressing-and-routing.md).
What is **specifically Nym** (rather than paper Sphinx) must be stated rather
than conflated: X25519+HKDF key schedule, AES-128-CTR header onion, Lioness
payload, SURB key seeds, replay tags, and the framing/ack/cover machinery.

---

## 5.10 Mitigations actually present in this repository

These are **enforced in code and covered by tests**, so they are behaviour
rather than prose. Run `./build.sh check` to verify all of them at once.

| Control | Section | Where | Test |
|---|---|---|---|
| Header MAC verified before decryption | §5.1.1 | `crates/sphinx-core/src/header.rs` | `tests/end_to_end.rs::tampered_header_is_rejected_by_the_mac` |
| Lioness wide-block payload | §5.1.1 | `crates/sphinx-core/src/payload.rs` | plaintext-recovery test |
| Random final-hop padding (Kuhn et al.) | §5.1.2 | `crates/sphinx-core/src/header.rs` | `build_final_hop` |
| Per-hop α blinding | §5.1.1 | `crates/sphinx-core/src/header.rs` | 3-hop route test |
| Distinct operator per path | §5.1.4 | `crates/sphinx-core/src/enforcement.rs` | `enforcement.rs::route_policy_rejects_repeated_operator` |
| No entry+exit collusion | §5.1.4 | `crates/sphinx-core/src/enforcement.rs` | `route_policy_rejects_entry_exit_collusion` |
| SURB single-use enforcement | §5.3.1 | `crates/sphinx-core/src/enforcement.rs` | `surb_pool_enforces_single_use` |
| SURB expiry (~25 h) | §5.3.3 | `crates/sphinx-core/src/enforcement.rs` | `surb_pool_rejects_expired_surbs` |
| Bounded SURB attachment | §5.3.2/§5.3.4 | `crates/sphinx-core/src/enforcement.rs` | `route_policy_bounds_surb_attachment` |
| Reply budget (token bucket) | §5.3.4 | `crates/sphinx-core/src/enforcement.rs` | `reply_budget_limits_bursts` |
| Exit rotation (P2) | §5.2.2/§5.4.3 | `crates/sphinx-core/src/enforcement.rs` | `exit_rotation_policies_behave` |
| Exit reconnect jitter | §5.2.3 | `enforcement.mjs` (`ExitPolicy` ±10 jitter, wired in `fetch.ts`) | `web/test/enforcement.test.mjs` |
| Keystore-backed identity | §5.6 | `web/src/social/keystore.mjs` + `NysirisKeystorePlugin.java` | `web/test/keystore.test.mjs` |
| Adversarial chaos harness | §5.3–§5.4 | `ReplyTracker`/`ReplyBudget` under replay storms, hoarding bursts, clock skew | `web/test/chaos-enforcement.test.mjs` (7 tests) |
| Cover-traffic guardrail | §5.8 | `crates/sphinx-core/src/enforcement.rs` | `privacy_profile_guardrail` |
| Bridge open-proxy guards | §5.10 | `crates/bridge-guard/src/lib.rs` | `tests/guard.rs` (8 tests) |
| Leak-guard decisions, fail-closed | §5.6 | `web/src/mixnet/routedHosts.mjs` + `leakGuard.ts` | `web/test/routedHosts.test.mjs` (7 tests) |
| Browser reply dedupe + TTL | §5.3.1/§5.3.3 | `web/src/mixnet/enforcement.mjs` (`ReplyTracker`) | `web/test/enforcement.test.mjs` |
| Browser reply rate limit | §5.3.4 | `web/src/mixnet/enforcement.mjs` (`ReplyBudget`) | `web/test/enforcement.test.mjs` |
| Browser privacy guardrail | §5.8 | `enforcement.mjs` + `web/src/mixnet/tunnel.ts` | `web/test/enforcement.test.mjs` |
| Attachment validation (client) | §9.5b | `web/src/social/attachments.mjs` (MIME/size/count/names) | `web/test/attachments.test.mjs` (5 tests) |
| Attachment encryption round-trip | §9.5b | `web/src/social/attachmentCrypto.ts` (XChaCha, content address) | `web/test/attachments-crypto.test.mjs` (4 tests) |
| Attachment signature binding | §9.5b | `sig::post_message` + `attach::canonical_attachments`, DM inner v2 | `sig` + `service` attachment tests |
| Blob content addressing + caps | §9.5b | `services/social` `/blob/part` + `GET /blob` (hash verify, 256 KiB, PoW/rate) | `blob_parts_*` + `blobs_round_trip` store tests |
| Parser robustness (random/mutated bytes) | §5.1 | `crates/sphinx-core/tests/fuzz_parser.rs` | 6 fuzz tests |
| Route/message soak | §5.1–§5.3 | `crates/sphinx-core/tests/soak.rs` | `./build.sh soak` |

**Configured / operational controls** (verified by config, not unit test):

| Control | Where | Notes |
|---|---|---|
| Address parsing (no directory) | `crates/sphinx-core/src/address.rs` | Out-of-band resolution only |
| Strict CSP (`worker-src`/`blob:`) | `web/index.html` | Correct tunnel + bootstrap policy |
| No cleartext on Android | `android/` | Manifest + network security config |
| Provider has no inbound ports | `services/echo-provider/` | Outbound WSS only |
| No identifier logging | services + docs | Addresses/destinations kept out of logs |
| Gateway management API firewalled | `services/gateway/` | `http.bind_address = 127.0.0.1` |

---

## 5.11 Residual risks and explicit non-goals

* **Endpoint compromise** — assumed lost; nothing here helps.
* **Bulk / long-lived flows** — correlation is an open question; do not rely on
  the mixnet for them.
* **Application identity** — logins, cookies, tokens, and request content are
  visible to the destination; Layer-2 hygiene is yours.
* **Formal guarantee vs L3G** — the network raises cost; it does not prove
  immunity for a global adversary controlling entry and exit.
* **Browser scope** — a web/WASM client routes only traffic that passes through
  it. Whole-browser/whole-device routing needs `nym-socks5-client` (desktop) or
  **NymVPN** (all platforms).
* **Reference core is not production crypto** — use Nym's audited crates
  (`nym-sdk`, `nym-sphinx`, `sphinx-packet`, `@nymproject/*`).

---

## 5.12 Audits and disclosure

Nym publishes third-party security audits of its mixnet and cryptography
(early cryptographic review followed by later formal appraisals). **Verify the
current, authoritative list and the latest reports before relying on them**;
audit status changes over time, and this document should not be treated as
evidence of a specific audit. Report vulnerabilities through Nym's published
security contact rather than public issues.

---

## 5.13 Checklists

**Client**
- [ ] TLS only (`https://`, `wss://`); no cleartext anywhere (CSP + Android config).
- [ ] Leak guard installed; fail-closed in development and CI.
- [ ] Exit rotated per request (or pinning consciously accepted).
- [ ] No cross-session correlators; short-lived connections.
- [ ] Randomised request timing; decoys/batching for sensitive paths.
- [ ] SURBs: single-use enforced, minimal count, replenishment capped, purged on expiry.
- [ ] Keys backed up where identity must persist; rotated where it must not.
- [ ] Cover traffic left ON in production; switches gated behind a warning.

**Service provider**
- [ ] No inbound ports; egress only to the gateway.
- [ ] Persistent storage backed up; gateway pinned if the address must be stable.
- [ ] Reply rate within the ~50 pkt/s budget; replies sized to one packet.
- [ ] SURB replenishment capped; reply amplification bounded.
- [ ] No logging of Nym addresses, destinations, or payloads.
- [ ] Content-level end-to-end encryption for sensitive replies.

**Exit / gateway operator**
- [ ] Exit policy checked and enforced (deny by default).
- [ ] Abuse handling and legal review done **before** running an exit.
- [ ] Management API firewalled; WSS via reverse proxy.
- [ ] Entry and exit not pinned to the same operator by clients.
- [ ] Monitoring that never records destinations or addresses.

---

Next: [`06-roadmap.md`](06-roadmap.md) tracks Phase 4 (hardening & operations),
where these controls become acceptance criteria.
