# 17. Monero escrow for nysiris-shop — stagenet reference

**Status: experimental specification + stagenet-only reference.** This document
does **not** describe a production payment system. It defines a protocol in
which three *external* Monero wallets hold the keys and Nysiris only relays
signed messages and opaque wallet blobs. No mainnet integration, bundled
wallet, or automatic dispute resolution is implemented.

> Monero's own docs still label multisig an experimental feature and warn that
> an unknown bug could let a malicious group member steal all funds. Treat the
> limits in §17.10 as part of the design, not fine print.

---

## 17.1 What problem this solves

`nysiris-shop` (doc 16) signs listings, orders, state transitions, threads, and
reviews but explicitly never touches money. Settlement and refunds are between
the parties. This document adds an **optional** escrow track for XMR listings:

1. buyer, seller, and an agreed arbiter create a fresh **2-of-3 Monero multisig
   wallet** for one shop order;
2. the buyer funds that wallet with exactly `price × qty` piconeros;
3. on fulfilment, seller + buyer sign a payout to the seller; only after a
   dispute does the arbiter supply the second signature for either outcome;
4. every protocol message is signed by the existing Nym/ed25519 shop identity,
   so the untrusted shop provider can relay it but cannot forge or rewrite it.

The Nysiris provider remains a bulletin board. It never sees spend keys, never
signs a Monero transaction, and never holds funds.

## 17.2 Parties and trust

| Party | Holds | Can | Cannot |
|---|---|---|---|
| Buyer B | one Monero multisig key share + Nym identity key | fund, propose refund, approve payout, open dispute | spend alone; read another order's escrow state |
| Seller S | one share + Nym identity key | propose payout, accept/cancel, respond to dispute | spend alone; change the frozen price |
| Arbiter A | one share + Nym identity key | break a tie with one other signer | spend alone; force a result without a dispute |
| Shop provider C | signed messages only | order the log, enforce size/rate caps | forge a signature, sign, learn spend keys, redirect funds |

The arbiter is **not** the shop provider by default. If an operator also runs
an arbiter, that must be a separately keyed, separately accountable service;
the buyer and seller must explicitly agree to that identity in the `open`
message. The impersonation attack in §17.10 is the reason: a participant who
can impersonate the arbiter during setup can construct a 2-of-3 wallet they
control alone.

## 17.3 Monero constraints this design accepts

These are properties of current Monero, not choices we can configure away:

* Multisig is emulated by **secret splitting**. There is no on-chain "multisig
  address" marker: an observer cannot tell an escrow output from a normal one.
* All three participants learn the escrow wallet's **public address and private
  view key** during setup. Reusing one escrow wallet for several orders would
  let participants correlate those orders. **One fresh wallet per order** is
  therefore mandatory.
* Setup needs several rounds (`prepare_multisig` → `make_multisig 2` → two
  `exchange_multisig_keys` rounds for 2-of-3) and then an output-sync round
  (`export_multisig_info` / `import_multisig_info`) before the wallet can spend.
  The round blobs contain key material; prefer an **end-to-end encrypted**
  channel (the social service's signed/dead-drop DMs, doc 9, or an external
  E2E channel). The optional shop relay will store a signed `join` envelope if
  sent to it, so using it exposes those blobs to the provider — accept that
  trade-off explicitly or keep setup E2E.
* There is **no HTLC or enforced timelock refund**. Since v0.18.3.4, relay
  rules enforce `unlock_time = 0`. A timeout can only mark an order abandoned
  in the signed log; it cannot move coins. Someone must still sign.
* `get_tx_proof`/`check_tx_proof` prove that a payment was made to an address;
  they do **not** prove the funds are still unspent or spendable. Confirmations,
  the escrow wallets' incoming transfers, and `get_balance` are additional
  checks, not proofs.
* A malicious signer can withhold a half-signed transaction, claim "stale
  data", and get a second transaction signed that spends a *different* output
  (doc "Spending concerns"). Every signer must hash the full canonical
  `describe_transfer.desc` (inputs, recipients, change, fee, unlock time, extra)
  and sign a given transaction at most once; comparing inputs alone is unsafe.

## 17.4 Terms, amounts, and currency

* Escrow is only offered when the shop listing's `currency` is `XMR`.
* For XMR, the shop `price` is an integer count of **piconeros**, the smallest
  unit: `1 XMR = 1_000_000_000_000` atomic units. (Doc 16's "cents" wording is
  a generic minor-unit example; this profile fixes the scale.)
* `amount = price × qty` in piconeros, computed with checked arithmetic. The
  reference profile caps it at `MAX_ESCROW_ATOMIC` (10 XMR) and rejects
  overflow. No float enters any signature or RPC call.
* Monero network fees are paid from the escrow wallet. The seller therefore
  receives `amount − fee` on a normal release; the quote must account for it.
  Do not silently add a fee to the shop price.
* Before signing `open`, each client must load the referenced shop order (doc
  16), verify its `order` signature and `ORDER_STATUS_DOMAIN` chain, and confirm
  that it is still `reserved` or `accepted`, that `amount == price × qty`, and
  that `currency == XMR`. The pure state machine only sees the resulting
  16-byte order id and integer amount; the shop relay loads the signed shop
  order to enforce that binding (including order status) before storing an
  `open`.

### 17.4.1 End-to-end flow

1. Seller publishes an XMR listing with `price` in piconeros. Buyer reserves it
   with a signed order (doc 16); the provider deducts availability. The order
   must still be `reserved` or `accepted` when escrow opens.
2. Buyer signs `open` naming the order id, seller, arbiter, `amount`, and `XMR`,
   and submits it to `POST /escrow/open`. The relay re-derives the parties and
   amount from the signed order, so an unrelated client cannot open a session
   or change the terms.
3. All three wallets run the external setup and output-sync rounds. Each
   participant signs a `join` with its blob, then a final-round `commit`
   carrying the same escrow address and independently derived transcript hash.
   Prefer E2E DMs for the blobs; `/escrow/event` will store them if used.
4. Buyer funds **that** address from a separate stagenet wallet, obtains a
   `get_tx_proof` over a message that includes the frozen amount, and signs
   `funded`. Each escrow signer checks `check_tx_proof` (`good`, amount,
   ≥10 confirmations, not in pool), the receiving transfer (`type=in`,
   `unlock_time=0`, unlocked, no double spend), and `get_balance` locally before
   trusting the stage change. The relay cannot validate the proof itself.
5. Happy path: the seller's `transfer` prints a `txset_hash` over the full
   `describe_transfer.desc`; the seller signs `release` with that hash and the
   inputs hash. The buyer compares the same description, signs `approve`
   binding that release, and one signer submits with `submitted(kind=0)`. The
   seller then marks the shop order `fulfilled`, the only reviewable state.
6. Dispute path: buyer or seller signs `dispute`; the arbiter signs `resolve`
   with the decision, payout, and inputs. The decision winner signs the
   matching `release`, then the arbiter signs `approve` for that exact release.
   `submitted(kind=1)` records a refund txid. No timelock or automatic refund
   exists — both exits are signed spends.
7. Clients read `GET /escrow/<order>` and replay every envelope through
   `EscrowState::apply_replay`, reaching the same stage independently of the
   provider's convenience `stage` field.

## 17.5 Wire grammar

All messages use the existing shop identity scheme: ed25519 over a 32-byte
public key, coarse UTC `day` (`unix_time / 86400`, accepted within ±2 days), a
per-actor monotonically increasing `seq`, and domain-separated concatenation.
Fixed-size fields come first; variable fields carry `u16` byte lengths. Every
message ends with the 64-byte signature over all preceding bytes.

```text
envelope   = domain(24) || actor(32) || day_be64 || seq_be64 || payload || sig(64)

open       = order(16) || nonce(16) || seller(32) || arbiter(32)
             || amount_be64 || currency(3)                       [buyer]
join       = order(16) || nonce(16) || role(1)
             || blob_len_be16 || blob                            [each party]
commit     = order(16) || nonce(16) || round(1)
             || addr_len_be16 || address || transcript_hash(32)  [each party]
funded     = order(16) || nonce(16) || txid(32) || amount_be64
             || proof_len_be16 || proof                          [buyer]
release    = order(16) || nonce(16) || payout_len_be16 || payout
             || amount_be64 || inputs_hash(32) || txset_hash(32) [seller]
approve    = order(16) || nonce(16) || release_digest(32)
             || role(1)                                          [buyer | arbiter]
dispute    = order(16) || nonce(16) || reason(1)
             || body_len_be16 || body                            [buyer | seller]
resolve    = order(16) || nonce(16) || dispute_digest(32)
             || decision(1) || payout_len_be16 || payout
             || inputs_hash(32)                                  [arbiter]
cancel     = order(16) || nonce(16) || reason(1)                 [buyer]
submitted  = order(16) || nonce(16) || txid(32) || kind(1)        [any signer]
```

Domains are 24-byte, NUL-padded constants `fly-escrow-v1/<name>` in
`crates/escrow-format/src/message.rs`. They are an immutable release contract:
renaming one invalidates every signed escrow message.

`role` is `0 = buyer`, `1 = seller`, `2 = arbiter`. `decision` is
`0 = pay seller`, `1 = refund buyer`. `kind` is `0 = release`, `1 = refund`.
`release_digest`/`dispute_digest` are SHA-256 of the complete signed envelope
they refer to. `inputs_hash` is SHA-256 of the canonical `describe_transfer`
input list; `txset_hash` is SHA-256 of the **full canonical**
`describe_transfer.desc` list (inputs plus recipients, change, fee, unlock
time, ring size, and extra). The same hash is printed by the harness and must
be checked before `sign_multisig` and `submit_multisig`. UTF-8 text fields are
NUL-free and length-capped.

Limits (mirrored by `scripts/check-constants.mjs`):

| Constant | Value | Purpose |
|---|---|---|
| `MAX_ESCROW_ATOMIC` | 10_000_000_000_000 | reference cap, 10 XMR |
| `MAX_BLOB_BYTES` | 16_384 | one multisig setup round blob |
| `MAX_ENVELOPE_BYTES` | 32_768 | one complete signed envelope accepted by the relay |
| `MAX_PROOF_BYTES` | 8_192 | transaction proof string |
| `MAX_ADDRESS_BYTES` | 128 | Monero address / payout address |
| `MAX_BODY_BYTES` | 256 | dispute reason body |
| `MAX_SEQ` | 2^63−1 | replay bound |

## 17.6 State machine

```text
proposed ──all 3 join──▶ joined ──all 3 commit same address──▶ setup
   │                                                              │
buyer cancel                                              buyer funded proof
   ▼                                                              ▼
cancelled                                                   awaiting_spend
                                                              │      │
                                  seller release + buyer approve
                                                              ▼      │
                                                           releasing  │ dispute
                                                              │       ▼
                                                    submitted      disputed
                                                              │       │ arbiter resolve
                                                              ▼       ▼
                                                           released  resolved ──▶ releasing
                                                                     (winner release + arbiter approve)
```

Rules enforced by `crates/escrow-format/src/state.rs`:

* `open`: buyer only, `seq` starts at 0, names both other parties.
* `join`: each role exactly once, while `proposed`; the actor must be one of
  the three named keys and the role must match that key.
* `commit`: only after all three joins; this profile signs only the **final**
  setup round (`round = 3`). All three addresses must be identical, and each
  client independently derives `transcript_hash` from the order, nonce, and
  address instead of trusting a value chosen by one party. Mismatch is a hard
  failure — discard the wallet and start a new nonce, never "pick a majority".
* `funded`: buyer only, after three matching commits; amount must equal the
  frozen `amount` and the txid must be non-zero. The signed envelope proves who
  claimed funding; local wallet checks (`check_tx_proof` amount/confirmations,
  incoming transfer, unlocked balance) are what make the claim trustworthy.
* `release`: seller only from `awaiting_spend` (winner only after `resolve`);
  binds payout, amount, non-zero inputs hash, and non-zero txset hash. A
  second release with a different `inputs_hash` is rejected.
* `approve`: binds the exact `release_digest`. For a normal payout **only the
  buyer** may approve; the arbiter has no happy-path spend power. For a
  resolved dispute **only the arbiter** may approve the winner's release.
* `dispute`: buyer or seller, from `awaiting_spend` only; freezes `release`.
* `resolve`: arbiter only, from `disputed`; binds the dispute and the payout
  inputs. It is an instruction, not a wallet signature: `pay seller` needs the
  seller's release plus the arbiter's approval; `refund buyer` needs the
  buyer's release plus the arbiter's approval.
* `submitted`: any signer after the required two signatures; records a
  non-zero txid. `kind` must be `0` for a normal payout and match the decision
  for a refund. Only then is the order `released`.
* `cancel`: buyer only, before `funded`. After funding, only a signed spend
  can move coins. An unfunded session past the local funding window is only a
  pure client hint (`fundingExpired()` / `funding_expired()`): it never changes
  the replayed `stage` and never refunds anything. Abandonment still requires a
  buyer-signed `cancel`.
* Per-actor `seq` must strictly increase. Rejected writes do not consume a
  slot and do not mutate client state. The provider may replay the log;
  clients must reach the same stage.

## 17.7 Wallet RPC mapping

The reference harness (`scripts/monero_escrow_stagenet.py`) calls a local
`monero-wallet-rpc --stagenet` per party. Nothing in this table requires the
PWA to hold keys.

| Protocol step | Wallet RPC (party-local) |
|---|---|
| setup round 0 | `prepare_multisig` |
| setup round 1 | `make_multisig 2 <info1> <info2>` |
| setup rounds 2–3 | `exchange_multisig_keys <infos…>` until all addresses match |
| pre-spend sync | `export_multisig_info` / `import_multisig_info` from both co-signers |
| funding proof | `get_tx_proof` over `nysiris-escrow:<order>:<nonce>:funded:<amount>` on the buyer's sending wallet |
| proof check | `check_tx_proof` (good, amount, confirmations, not in pool), `get_transfer_by_txid`, and `get_balance` on each escrow wallet |
| propose payout | `transfer` with `do_not_relay: true`, then `describe_transfer`; hash its full `desc` as `txset_hash` |
| co-sign | `sign_multisig` only when the full `describe_transfer` hash matches the signed release's `txset_hash` |
| broadcast | `submit_multisig` only when the same hash still matches (explicit `--broadcast`) |
| confirm | `get_transfer_by_txid` / `get_tx_proof` on the signed tx |

The harness refuses to run without an explicit `--stagenet` flag, uses
`validate_address` to reject any configured or payout address whose wallet-RPC
`nettype` is not `stagenet`, keeps a `0600` state file, caps the amount, binds
the proof message to the amount, checks `received` plus spendability, records
seen `inputs_hash` values, and hashes the full `describe_transfer.desc` before
cosigning or broadcasting. `cosign` and `submit` require the `txset_hash` from
the signed release envelope, so a different payout, fee, change, or unlock time
cannot be substituted. It never reads or writes seeds, spend keys, or wallet
files.

### 17.7.1 Shop relay API

`nysiris-shop` is the optional relay for these envelopes. It has no wallet, no
RPC client, and no key material; it verifies signatures, checks that the signed
shop order is `reserved` or `accepted` with `currency = XMR` and
`amount = price × qty`, replays the whole log, and stores the exact signed
bytes. Rejected writes refund their rate slot. Reads need the same
`for`/`day`/`sig` proof of possession as private orders and are limited to the
three named participants.

| Route | Body / query | Effect |
|---|---|---|
| `POST /escrow/open` | `{order, envelope}` | Buyer's `open` envelope; roles and `amount = price × qty` come from the signed order, never the request |
| `POST /escrow/event` | `{order, envelope}` | One non-`open` envelope; prior log is replayed before it is accepted |
| `GET /escrow` | `?for=&day=&sig=` | Sessions where the signer is buyer, seller, or arbiter |
| `GET /escrow/<order>` | `?for=&day=&sig=` | Session plus every signed envelope (hex) in acceptance order; clients replay them |

The provider's `stage` field is a convenience only. Clients re-verify each
signature and replay the log with `EscrowState::apply_replay` (Rust) or
`EscrowMirror.applyReplay()` / `replayRelayResponse()` (browser mirror in
`web/src/domain/escrow.ts`); a provider that reports a stage no signed chain
reaches is detectable. The relay stores
whatever the client sends, so setup blobs, payout addresses, txids, and proofs
sent through `POST /escrow/event` are visible to it — use the social service's
E2E DMs for those fields if that retention is unacceptable.

## 17.8 Privacy properties

* The shop provider sees signed protocol metadata (order id, roles, stages,
  coarse day) and the full envelope bytes when the relay is used. Setup blobs,
  payout addresses, txids, and proofs are **not** needed for routing and can be
  exchanged over the E2E DM channel instead; the reference harness keeps them
  local.
* Monero hides amounts and addresses on-chain, but all three escrow participants
  share the wallet view key and therefore see every deposit and payout of that
  one order. Fresh wallets per order prevent cross-order linking by the other
  participants.
* Never put shipping addresses, contact handles, or dispute evidence in these
  signed messages. Use the social service's encrypted dead-drops (doc 9).

## 17.9 Stagenet runbook

Prerequisites: `monerod --stagenet` (or a trusted stagenet remote node), three
fresh `monero-wallet-rpc --stagenet` processes on distinct ports with
`--rpc-login`, and one ordinary sender wallet for funding. Configure them with
basic-auth environment variables:

```sh
export MONERO_BUYER_RPC_URL=http://127.0.0.1:18081
export MONERO_BUYER_RPC_USER=buyer
export MONERO_BUYER_RPC_PASS=...
# same for MONERO_SELLER_RPC_* and MONERO_ARBITER_RPC_*
# MONERO_SENDER_RPC_* points at the buyer's ordinary funding wallet
```

Then:

```sh
python3 scripts/monero_escrow_stagenet.py --stagenet check
python3 scripts/monero_escrow_stagenet.py --stagenet setup \
  --order <hex16> --amount <piconeros> --state ./escrow-state.json
# sign the three `commit` envelopes (round 3) in a Nysiris client
python3 scripts/monero_escrow_stagenet.py --stagenet funding-proof \
  --state ./escrow-state.json --txid <hex64>
python3 scripts/monero_escrow_stagenet.py --stagenet verify-funding \
  --state ./escrow-state.json --txid <hex64> --amount <piconeros> --proof <proof>
python3 scripts/monero_escrow_stagenet.py --stagenet propose \
  --state ./escrow-state.json --role seller --payout <address> --amount <piconeros>
python3 scripts/monero_escrow_stagenet.py --stagenet cosign \
  --state ./escrow-state.json --role buyer --txset <hex> --release-txset-hash <hash>
python3 scripts/monero_escrow_stagenet.py --stagenet submit \
  --state ./escrow-state.json --role seller --txset <hex> \
  --release-txset-hash <hash> --broadcast
```

`setup`, `propose`, and `cosign` print JSON summaries that a Nysiris client
turns into envelopes with `crates/escrow-format` / `web/src/domain/escrow.ts`;
the wallet harness itself has no Nym identity and does not sign those envelopes.
The signed `commit` must be round 3 and carry the independently computed
`transcript_hash`. The signed `release` must carry the `txset_hash` printed by
`propose`; pass that same value to `cosign` and `submit`. `--broadcast` is
required for the one irreversible call.

## 17.10 Limits and known risks

* **Multisig is experimental upstream.** An unknown bug could allow theft by a
  group member. No mainnet use is endorsed by this repository.
* **Arbiter impersonation during setup** defeats 2-of-3: authenticate all three
  parties out-of-band and verify the final escrow address in three matching
  signed `commit` messages before funding.
* **Withheld-transaction double spend:** compare the full canonical
  `describe_transfer.desc` hash, sign once, and never treat "stale data" as a
  reason to blindly re-sign. Inputs alone are not enough.
* **Proofs are not spendability:** the harness cross-checks the proof amount,
  confirmations, incoming transfer state, and unlocked balance, but a proof can
  still describe a time-locked or already-spent output; these are risk checks,
  not cryptographic spendability guarantees.
* **Liveness is social:** an offline buyer/seller/arbiter can stall a payout.
  There is no automatic timeout payout on Monero.
* **No fee market, no partial refunds, no multi-item orders:** the reference
  profile settles one shop order in one payout. Split refunds need a new design.
* **Not a wallet:** the PWA has no key storage or signing UI for XMR. Keys stay
  in the participants' own wallet software.

This document intentionally does not amend the README's "no financial
features" claim into a mainnet claim. Escrow is an opt-in, stagenet-only
reference track until upstream multisig maturity and an external audit say
otherwise.

## 17.11 Files

| Path | Role |
|---|---|
| `crates/escrow-format/` | Byte-exact message grammar, signatures, state machine, limits |
| `scripts/monero_escrow_stagenet.py` | External-wallet stagenet RPC reference harness |
| `scripts/test_monero_escrow_stagenet.py` | Offline, mocked-RPC fail-closed harness checks |
| `web/src/domain/escrow.ts` | Byte-exact browser mirror of the wire layout and replay state machine |
| `web/test/escrow.test.mjs` | Cross-implementation vectors for every domain and the full replay log |
| `scripts/check-constants.mjs` | Fails if Rust/web domains or limits drift |
