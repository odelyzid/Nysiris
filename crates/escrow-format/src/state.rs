//! Role-scoped escrow state machine (doc 17 §17.6).
//!
//! This is deliberately independent of any transport: replaying the signed
//! message log through `EscrowState::apply` must always produce the same
//! stage. Every rejection is explicit — no silent zero/default values.

use crate::limits::{DAY_SKEW, FUNDING_DAYS, MAX_ESCROW_ATOMIC, MAX_SEQ};
use crate::message::{decode, setup_transcript_hash, verify_message, Decoded, Domain};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Proposed,
    Joined,
    Setup,
    AwaitingSpend,
    Releasing,
    Disputed,
    Resolved,
    Released,
    Cancelled,
}

impl Stage {
    /// Stable wire/storage name; do not rename (clients compare these strings).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Proposed => "proposed",
            Self::Joined => "joined",
            Self::Setup => "setup",
            Self::AwaitingSpend => "awaiting_spend",
            Self::Releasing => "releasing",
            Self::Disputed => "disputed",
            Self::Resolved => "resolved",
            Self::Released => "released",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone)]
struct ReleaseInfo {
    digest: [u8; 32],
    txset_hash: [u8; 32],
    resolved: bool,
}

#[derive(Debug, Clone)]
pub struct EscrowState {
    pub stage: Stage,
    pub order: [u8; 16],
    pub nonce: [u8; 16],
    pub buyer: [u8; 32],
    pub seller: [u8; 32],
    pub arbiter: [u8; 32],
    pub amount: u64,
    pub open_day: u64,
    opened: bool,
    joins: BTreeSet<u8>,
    commits: Vec<([u8; 32], [u8; 32], Vec<u8>)>,
    last_seq: BTreeMap<[u8; 32], u64>,
    release: Option<ReleaseInfo>,
    approvals: BTreeSet<[u8; 32]>,
    inputs_seen: BTreeSet<[u8; 32]>,
    dispute: Option<[u8; 32]>,
    decision: Option<u8>,
    winner: Option<[u8; 32]>,
    resolved_inputs: Option<[u8; 32]>,
    resolved_payout: Option<Vec<u8>>,
}

impl Default for EscrowState {
    fn default() -> Self {
        Self::new()
    }
}

impl EscrowState {
    pub fn new() -> Self {
        Self {
            stage: Stage::Proposed,
            order: [0; 16],
            nonce: [0; 16],
            buyer: [0; 32],
            seller: [0; 32],
            arbiter: [0; 32],
            amount: 0,
            open_day: 0,
            opened: false,
            joins: BTreeSet::new(),
            commits: Vec::new(),
            last_seq: BTreeMap::new(),
            release: None,
            approvals: BTreeSet::new(),
            inputs_seen: BTreeSet::new(),
            dispute: None,
            decision: None,
            winner: None,
            resolved_inputs: None,
            resolved_payout: None,
        }
    }

    /// Hash of the unsigned multisig txset bound by the current release. A
    /// cosigner compares this with its own wallet's description before signing.
    pub fn release_txset_hash(&self) -> Option<[u8; 32]> {
        self.release.as_ref().map(|r| r.txset_hash)
    }

    fn role_of(&self, actor: &[u8; 32]) -> Option<u8> {
        if actor == &self.buyer {
            Some(0)
        } else if actor == &self.seller {
            Some(1)
        } else if actor == &self.arbiter {
            Some(2)
        } else {
            None
        }
    }

    fn common_ok(&self, order: &[u8; 16], nonce: &[u8; 16]) -> Result<(), String> {
        if order != &self.order || nonce != &self.nonce {
            return Err("message belongs to a different escrow session".into());
        }
        Ok(())
    }

    /// Verify, decode, and apply a freshly submitted message. The coarse-day
    /// freshness window applies only here: old signed messages remain valid
    /// when replaying a stored log.
    pub fn apply(&mut self, signed: &[u8], now_day: u64) -> Result<(), String> {
        self.apply_inner(signed, Some(now_day))
    }

    /// Replay a previously accepted signed message without re-checking the
    /// freshness window. Clients and the shop relay use this to rebuild state
    /// from the event log days or weeks later.
    pub fn apply_replay(&mut self, signed: &[u8]) -> Result<(), String> {
        self.apply_inner(signed, None)
    }

    fn apply_inner(&mut self, signed: &[u8], now_day: Option<u64>) -> Result<(), String> {
        if self.stage == Stage::Released || self.stage == Stage::Cancelled {
            return Err("escrow session is closed".into());
        }
        let env = verify_message(signed)?;
        if let Some(now) = now_day {
            if env.day.abs_diff(now) > DAY_SKEW {
                return Err(format!(
                    "day {} outside the ±{DAY_SKEW} freshness window",
                    env.day
                ));
            }
        }
        if env.seq > MAX_SEQ {
            return Err("sequence above MAX_SEQ".into());
        }
        match self.last_seq.get(&env.actor) {
            None if env.seq != 0 => return Err("first message from an actor must use seq 0".into()),
            Some(last) if env.seq <= *last => {
                return Err(format!("replayed sequence {} (last {last})", env.seq))
            }
            _ => {}
        }
        let decoded = decode(&env)?;
        self.check_domain_shape(env.domain, &decoded)?;
        self.dispatch(env.domain, &env.actor, env.day, signed, &decoded)?;
        self.last_seq.insert(env.actor, env.seq);
        Ok(())
    }

    fn check_domain_shape(&self, domain: Domain, decoded: &Decoded) -> Result<(), String> {
        let ok = matches!(
            (domain, decoded),
            (Domain::Open, Decoded::Open { .. })
                | (Domain::Join, Decoded::Join { .. })
                | (Domain::Commit, Decoded::Commit { .. })
                | (Domain::Funded, Decoded::Funded { .. })
                | (Domain::Release, Decoded::Release { .. })
                | (Domain::Approve, Decoded::Approve { .. })
                | (Domain::Dispute, Decoded::Dispute { .. })
                | (Domain::Resolve, Decoded::Resolve { .. })
                | (Domain::Cancel, Decoded::Cancel { .. })
                | (Domain::Submitted, Decoded::Submitted { .. })
        );
        if ok {
            Ok(())
        } else {
            Err("decoded payload does not match its domain".into())
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn dispatch(
        &mut self,
        domain: Domain,
        actor: &[u8; 32],
        day: u64,
        signed: &[u8],
        decoded: &Decoded,
    ) -> Result<(), String> {
        match (domain, decoded) {
            (
                Domain::Open,
                Decoded::Open {
                    order,
                    nonce,
                    seller,
                    arbiter,
                    amount,
                    currency,
                },
            ) => {
                if self.opened {
                    return Err("escrow already opened".into());
                }
                if self.stage != Stage::Proposed {
                    return Err("open in wrong stage".into());
                }
                if order == &[0; 16] || nonce == &[0; 16] {
                    return Err("zero order id or nonce".into());
                }
                if *amount == 0 || *amount > MAX_ESCROW_ATOMIC {
                    return Err("amount outside the reference cap".into());
                }
                if currency != b"XMR" {
                    return Err("escrow requires XMR currency".into());
                }
                if actor == seller || actor == arbiter || seller == arbiter {
                    return Err("buyer, seller, and arbiter must be distinct".into());
                }
                self.order = *order;
                self.nonce = *nonce;
                self.buyer = *actor;
                self.seller = *seller;
                self.arbiter = *arbiter;
                self.amount = *amount;
                self.open_day = day;
                self.opened = true;
                Ok(())
            }
            (
                Domain::Join,
                Decoded::Join {
                    order,
                    nonce,
                    role,
                    blob,
                },
            ) => {
                if !self.opened || self.stage != Stage::Proposed {
                    return Err("join requires an open, unjoined session".into());
                }
                self.common_ok(order, nonce)?;
                if blob.is_empty() {
                    return Err("empty multisig setup blob".into());
                }
                if self.role_of(actor) != Some(*role) {
                    return Err("role does not match the signing key".into());
                }
                if !self.joins.insert(*role) {
                    return Err("duplicate join for this role".into());
                }
                if self.joins.len() == 3 {
                    self.stage = Stage::Joined;
                }
                Ok(())
            }
            (
                Domain::Commit,
                Decoded::Commit {
                    order,
                    nonce,
                    round,
                    address,
                    transcript_hash,
                },
            ) => {
                if self.stage != Stage::Joined {
                    return Err("commit requires all three joins".into());
                }
                if *round != 3 {
                    return Err("signed commit must be the final setup round".into());
                }
                self.common_ok(order, nonce)?;
                if self.role_of(actor).is_none() {
                    return Err("commit from an unknown participant".into());
                }
                if self.commits.iter().any(|(who, _, _)| who == actor) {
                    return Err("duplicate commit".into());
                }
                // Never trust a hash supplied by a single party: derive it
                // from the signed order, nonce, and agreed escrow address.
                if *transcript_hash != setup_transcript_hash(order, nonce, address) {
                    return Err("commit transcript hash does not match the derived session".into());
                }
                // Validate before mutating: a rejected third commit must not
                // poison the local log and block a corrected replacement.
                let mut pending = self.commits.clone();
                pending.push((*actor, *transcript_hash, address.clone()));
                if pending.len() == 3 {
                    let (first_hash, first_addr) = (&pending[0].1, &pending[0].2);
                    if pending
                        .iter()
                        .any(|(_, h, a)| h != first_hash || a != first_addr)
                    {
                        return Err(
                            "participants disagree on the escrow address; restart with a new nonce"
                                .into(),
                        );
                    }
                    self.stage = Stage::Setup;
                }
                self.commits = pending;
                Ok(())
            }
            (
                Domain::Funded,
                Decoded::Funded {
                    order,
                    nonce,
                    txid,
                    amount,
                    proof: _,
                },
            ) => {
                if self.stage != Stage::Setup {
                    return Err("funding proof in wrong stage".into());
                }
                self.common_ok(order, nonce)?;
                if actor != &self.buyer {
                    return Err("only the buyer can post funding".into());
                }
                if txid == &[0; 32] {
                    return Err("zero funding txid".into());
                }
                if *amount != self.amount {
                    return Err("funding amount does not match the frozen terms".into());
                }
                self.stage = Stage::AwaitingSpend;
                Ok(())
            }
            (
                Domain::Release,
                Decoded::Release {
                    order,
                    nonce,
                    payout,
                    amount,
                    inputs_hash,
                    txset_hash,
                },
            ) => {
                if self.stage != Stage::AwaitingSpend && self.stage != Stage::Resolved {
                    return Err("release proposal in wrong stage".into());
                }
                self.common_ok(order, nonce)?;
                let resolved = self.stage == Stage::Resolved;
                let expected = if resolved {
                    self.winner.ok_or("resolved session has no winner")?
                } else {
                    self.seller
                };
                if actor != &expected {
                    return Err("release must come from the seller or the dispute winner".into());
                }
                if *amount != self.amount {
                    return Err("release amount does not match the frozen terms".into());
                }
                if inputs_hash == &[0; 32] || txset_hash == &[0; 32] {
                    return Err("release must bind non-zero inputs and txset hashes".into());
                }
                if resolved {
                    if self.resolved_inputs != Some(*inputs_hash)
                        || self.resolved_payout.as_deref() != Some(payout.as_slice())
                    {
                        return Err("resolved release must bind the arbiter's decision".into());
                    }
                } else {
                    if self.inputs_seen.contains(inputs_hash) {
                        return Err(
                            "inputs already used for another transfer in this session".into()
                        );
                    }
                    self.inputs_seen.insert(*inputs_hash);
                }
                self.release = Some(ReleaseInfo {
                    digest: crate::message::digest(signed),
                    txset_hash: *txset_hash,
                    resolved,
                });
                self.stage = Stage::Releasing;
                Ok(())
            }
            (
                Domain::Approve,
                Decoded::Approve {
                    order,
                    nonce,
                    release_digest,
                    role,
                },
            ) => {
                if self.stage != Stage::Releasing {
                    return Err("approval in wrong stage".into());
                }
                self.common_ok(order, nonce)?;
                if self.role_of(actor).is_none() || actor == &self.seller {
                    return Err("approval must come from buyer or arbiter".into());
                }
                if self.role_of(actor) != Some(*role) {
                    return Err("approval role does not match the signing key".into());
                }
                let rel = self.release.as_ref().ok_or("no release to approve")?;
                if rel.digest != *release_digest {
                    return Err("approval binds a different release".into());
                }
                // A normal payout is the seller's release plus the BUYER's
                // approval. The arbiter may only supply the second signature
                // after a dispute has been resolved, never in the happy path.
                if rel.resolved {
                    if actor != &self.arbiter {
                        return Err("a resolved payout is approved only by the arbiter".into());
                    }
                } else if actor != &self.buyer {
                    return Err("a normal payout is approved only by the buyer".into());
                }
                if !self.approvals.insert(*actor) {
                    return Err("duplicate approval".into());
                }
                Ok(())
            }
            (
                Domain::Dispute,
                Decoded::Dispute {
                    order,
                    nonce,
                    reason: _,
                    body: _,
                },
            ) => {
                if self.stage != Stage::AwaitingSpend {
                    return Err("dispute in wrong stage".into());
                }
                self.common_ok(order, nonce)?;
                if actor != &self.buyer && actor != &self.seller {
                    return Err("dispute must come from buyer or seller".into());
                }
                self.dispute = Some(crate::message::digest(signed));
                self.stage = Stage::Disputed;
                Ok(())
            }
            (
                Domain::Resolve,
                Decoded::Resolve {
                    order,
                    nonce,
                    dispute_digest,
                    decision,
                    payout,
                    inputs_hash,
                },
            ) => {
                if self.stage != Stage::Disputed {
                    return Err("resolution in wrong stage".into());
                }
                self.common_ok(order, nonce)?;
                if actor != &self.arbiter {
                    return Err("only the arbiter can resolve".into());
                }
                if self.dispute != Some(*dispute_digest) {
                    return Err("resolution binds a different dispute".into());
                }
                self.resolved_inputs = Some(*inputs_hash);
                self.resolved_payout = Some(payout.clone());
                self.decision = Some(*decision);
                self.winner = Some(if *decision == 0 {
                    self.seller
                } else {
                    self.buyer
                });
                // The resolution names the winner and payout, but it is not a
                // wallet signature: the winner's release and the arbiter's
                // approval of that exact release are the two spend signatures.
                self.stage = Stage::Resolved;
                Ok(())
            }
            (
                Domain::Submitted,
                Decoded::Submitted {
                    order,
                    nonce,
                    txid,
                    kind,
                },
            ) => {
                if self.stage != Stage::Releasing {
                    return Err("submission in wrong stage".into());
                }
                self.common_ok(order, nonce)?;
                if self.role_of(actor).is_none() {
                    return Err("submission from an unknown participant".into());
                }
                if self.release.as_ref().map(|r| r.resolved).unwrap_or(false) {
                    if !self.approvals.contains(&self.arbiter) {
                        return Err("a resolved payout needs the arbiter's signature".into());
                    }
                } else if self.approvals.is_empty() {
                    return Err("submission needs two signatures".into());
                }
                if txid == &[0; 32] {
                    return Err("zero submission txid".into());
                }
                let rel = self.release.as_ref().ok_or("no release to submit")?;
                let expected_kind = if rel.resolved {
                    u8::from(self.decision == Some(1))
                } else {
                    0 // normal payouts are never refunds
                };
                if *kind != expected_kind {
                    return Err("submission kind does not match the payout".into());
                }
                self.stage = Stage::Released;
                Ok(())
            }
            (
                Domain::Cancel,
                Decoded::Cancel {
                    order,
                    nonce,
                    reason: _,
                },
            ) => {
                if !matches!(self.stage, Stage::Proposed | Stage::Joined | Stage::Setup) {
                    return Err("cancel only before funding".into());
                }
                self.common_ok(order, nonce)?;
                if actor != &self.buyer {
                    return Err("only the buyer can cancel".into());
                }
                self.stage = Stage::Cancelled;
                Ok(())
            }
            _ => Err("message domain does not match decoded payload".into()),
        }
    }

    /// Whether an unfunded session has passed the local funding window.
    ///
    /// This is a pure hint for clients: it never mutates `stage`, because every
    /// authoritative stage must be reachable by replaying signed envelopes.
    /// Moving an abandoned session to `Cancelled` requires a buyer-signed
    /// `cancel`; nothing here moves coins (a refund is always a signed spend).
    pub fn funding_expired(&self, now_day: u64) -> bool {
        self.opened
            && matches!(self.stage, Stage::Proposed | Stage::Joined | Stage::Setup)
            && now_day >= self.open_day.saturating_add(FUNDING_DAYS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{
        approve_message, cancel_message, commit_message, dispute_message, funded_message,
        join_message, open_message, release_message, resolve_message, sign_message,
        submitted_message,
    };
    use ed25519_dalek::SigningKey;

    const DAY: u64 = 20_000;
    const ORDER: [u8; 16] = [0xa1; 16];
    const NONCE: [u8; 16] = [0xb2; 16];
    const HASH: [u8; 32] = [0xc3; 32];
    const ADDR: &[u8] = b"56MD1L4zky3bFXDQb9qvSx7PDbg8F4x1HgPrFNrDnGnYDqFZcWGswWc1p2moFa1F44ccJniY9Wkzk6urkJbEDvubHqYtkcs";

    fn transcript() -> [u8; 32] {
        setup_transcript_hash(&ORDER, &NONCE, ADDR)
    }

    struct Actors {
        buyer: SigningKey,
        seller: SigningKey,
        arbiter: SigningKey,
    }

    impl Actors {
        fn new() -> Self {
            Self {
                buyer: SigningKey::from_bytes(&[1; 32]),
                seller: SigningKey::from_bytes(&[2; 32]),
                arbiter: SigningKey::from_bytes(&[3; 32]),
            }
        }
    }

    fn sign(unsigned: Vec<u8>, key: &SigningKey) -> Vec<u8> {
        sign_message(unsigned, key)
    }

    /// Apply the common prefix through three matching commits.
    fn setup_session() -> (EscrowState, Actors) {
        let a = Actors::new();
        let b = a.buyer.verifying_key().to_bytes();
        let s = a.seller.verifying_key().to_bytes();
        let r = a.arbiter.verifying_key().to_bytes();
        let mut st = EscrowState::new();

        st.apply(
            &sign(
                open_message(&b, DAY, 0, &ORDER, &NONCE, &s, &r, 500, b"XMR").unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                join_message(&b, DAY, 1, &ORDER, &NONCE, 0, b"buyer-join").unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                join_message(&s, DAY, 0, &ORDER, &NONCE, 1, b"seller-join").unwrap(),
                &a.seller,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                join_message(&r, DAY, 0, &ORDER, &NONCE, 2, b"arbiter-join").unwrap(),
                &a.arbiter,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                commit_message(&b, DAY, 2, &ORDER, &NONCE, 3, ADDR, &transcript()).unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                commit_message(&s, DAY, 1, &ORDER, &NONCE, 3, ADDR, &transcript()).unwrap(),
                &a.seller,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                commit_message(&r, DAY, 1, &ORDER, &NONCE, 3, ADDR, &transcript()).unwrap(),
                &a.arbiter,
            ),
            DAY,
        )
        .unwrap();
        assert_eq!(st.stage, Stage::Setup);
        (st, a)
    }

    /// Apply the common prefix through `funded`; returns the state and keys.
    fn funded_session() -> (EscrowState, Actors) {
        let (mut st, a) = setup_session();
        let b = a.buyer.verifying_key().to_bytes();
        st.apply(
            &sign(
                funded_message(&b, DAY, 3, &ORDER, &NONCE, &HASH, 500, b"good-proof").unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        assert_eq!(st.stage, Stage::AwaitingSpend);
        (st, a)
    }

    #[test]
    fn seller_release_plus_buyer_approval_completes() {
        let (mut st, a) = funded_session();
        let s = a.seller.verifying_key().to_bytes();
        let b = a.buyer.verifying_key().to_bytes();
        let release = sign(
            release_message(
                &s,
                DAY,
                2,
                &ORDER,
                &NONCE,
                b"5SellerPayout",
                500,
                &[4; 32],
                &[5; 32],
            )
            .unwrap(),
            &a.seller,
        );
        let digest = crate::message::digest(&release);
        st.apply(&release, DAY).unwrap();
        st.apply(
            &sign(
                approve_message(&b, DAY, 4, &ORDER, &NONCE, &digest, 0).unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                submitted_message(&s, DAY, 3, &ORDER, &NONCE, &[6; 32], 0).unwrap(),
                &a.seller,
            ),
            DAY,
        )
        .unwrap();
        assert_eq!(st.stage, Stage::Released);
    }

    #[test]
    fn dispute_refund_binds_arbiter_decision_and_winner_release() {
        let (mut st, a) = funded_session();
        let b = a.buyer.verifying_key().to_bytes();
        let s = a.seller.verifying_key().to_bytes();
        let r = a.arbiter.verifying_key().to_bytes();
        let dispute = sign(
            dispute_message(&b, DAY, 4, &ORDER, &NONCE, 1, b"never delivered").unwrap(),
            &a.buyer,
        );
        let dispute_digest = crate::message::digest(&dispute);
        st.apply(&dispute, DAY).unwrap();
        st.apply(
            &sign(
                resolve_message(
                    &r,
                    DAY,
                    2,
                    &ORDER,
                    &NONCE,
                    &dispute_digest,
                    1,
                    b"5BuyerRefund",
                    &[7; 32],
                )
                .unwrap(),
                &a.arbiter,
            ),
            DAY,
        )
        .unwrap();
        // The seller cannot spend after the arbiter rules for the buyer.
        assert!(st
            .apply(
                &sign(
                    release_message(
                        &s,
                        DAY,
                        3,
                        &ORDER,
                        &NONCE,
                        b"5SellerPayout",
                        500,
                        &[7; 32],
                        &[8; 32]
                    )
                    .unwrap(),
                    &a.seller
                ),
                DAY,
            )
            .is_err());
        let winner_release = sign(
            release_message(
                &b,
                DAY,
                5,
                &ORDER,
                &NONCE,
                b"5BuyerRefund",
                500,
                &[7; 32],
                &[8; 32],
            )
            .unwrap(),
            &a.buyer,
        );
        let winner_digest = crate::message::digest(&winner_release);
        st.apply(&winner_release, DAY).unwrap();
        // The arbiter's resolution is an instruction, not a wallet signature;
        // it must approve this exact release before a refund can broadcast.
        st.apply(
            &sign(
                approve_message(&r, DAY, 3, &ORDER, &NONCE, &winner_digest, 2).unwrap(),
                &a.arbiter,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                submitted_message(&b, DAY, 6, &ORDER, &NONCE, &[9; 32], 1).unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        assert_eq!(st.stage, Stage::Released);
    }

    #[test]
    fn rejects_role_stage_and_replay_violations() {
        let (mut st, a) = funded_session();
        let b = a.buyer.verifying_key().to_bytes();
        let r = a.arbiter.verifying_key().to_bytes();

        // Only the seller may open a normal release.
        assert!(st
            .apply(
                &sign(
                    release_message(&b, DAY, 4, &ORDER, &NONCE, b"5Buyer", 500, &[1; 32], &[2; 32])
                        .unwrap(),
                    &a.buyer
                ),
                DAY,
            )
            .is_err());

        // Funding is irreversible in the signed log, even by its author.
        assert!(st
            .apply(
                &sign(
                    cancel_message(&b, DAY, 4, &ORDER, &NONCE, 0).unwrap(),
                    &a.buyer
                ),
                DAY
            )
            .is_err());

        // Replayed sequence numbers do not consume a new slot.
        assert!(st
            .apply(
                &sign(
                    funded_message(&b, DAY, 3, &ORDER, &NONCE, &HASH, 500, b"again").unwrap(),
                    &a.buyer
                ),
                DAY
            )
            .is_err());

        // Unnamed keys cannot act as arbiter.
        assert!(st
            .apply(
                &sign(
                    dispute_message(&r, DAY, 2, &ORDER, &NONCE, 1, b"nope").unwrap(),
                    &a.arbiter
                ),
                DAY,
            )
            .is_err());
    }

    #[test]
    fn mismatched_commits_never_reach_setup() {
        let a = Actors::new();
        let b = a.buyer.verifying_key().to_bytes();
        let s = a.seller.verifying_key().to_bytes();
        let r = a.arbiter.verifying_key().to_bytes();
        let mut st = EscrowState::new();
        st.apply(
            &sign(
                open_message(&b, DAY, 0, &ORDER, &NONCE, &s, &r, 500, b"XMR").unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                join_message(&b, DAY, 1, &ORDER, &NONCE, 0, b"b").unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                join_message(&s, DAY, 0, &ORDER, &NONCE, 1, b"s").unwrap(),
                &a.seller,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                join_message(&r, DAY, 0, &ORDER, &NONCE, 2, b"r").unwrap(),
                &a.arbiter,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                commit_message(&b, DAY, 2, &ORDER, &NONCE, 3, ADDR, &transcript()).unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                commit_message(&s, DAY, 1, &ORDER, &NONCE, 3, ADDR, &transcript()).unwrap(),
                &a.seller,
            ),
            DAY,
        )
        .unwrap();
        let bad = sign(
            commit_message(&r, DAY, 1, &ORDER, &NONCE, 3, b"56Different", &transcript()).unwrap(),
            &a.arbiter,
        );
        assert!(st.apply(&bad, DAY).is_err());
        assert_eq!(st.stage, Stage::Joined);
        // The rejected commit consumed no sequence slot and left no state
        // behind, so a corrected bad-commit replacement is accepted.
        st.apply(
            &sign(
                commit_message(&r, DAY, 1, &ORDER, &NONCE, 3, ADDR, &transcript()).unwrap(),
                &a.arbiter,
            ),
            DAY,
        )
        .unwrap();
        assert_eq!(st.stage, Stage::Setup);
    }

    #[test]
    fn only_the_buyer_approves_a_normal_release() {
        let (mut st, a) = funded_session();
        let b = a.buyer.verifying_key().to_bytes();
        let s = a.seller.verifying_key().to_bytes();
        let r = a.arbiter.verifying_key().to_bytes();
        let release = sign(
            release_message(
                &s, DAY, 2, &ORDER, &NONCE, b"5Seller", 500, &[4; 32], &[5; 32],
            )
            .unwrap(),
            &a.seller,
        );
        let digest = crate::message::digest(&release);
        st.apply(&release, DAY).unwrap();
        assert_eq!(st.release_txset_hash(), Some([5; 32]));

        // The arbiter has no happy-path veto or spend power.
        assert!(st
            .apply(
                &sign(
                    approve_message(&r, DAY, 2, &ORDER, &NONCE, &digest, 2).unwrap(),
                    &a.arbiter,
                ),
                DAY,
            )
            .is_err());
        st.apply(
            &sign(
                approve_message(&b, DAY, 4, &ORDER, &NONCE, &digest, 0).unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();

        // A normal payout cannot be logged as a dispute refund.
        assert!(st
            .apply(
                &sign(
                    submitted_message(&s, DAY, 3, &ORDER, &NONCE, &[6; 32], 1).unwrap(),
                    &a.seller,
                ),
                DAY,
            )
            .is_err());
        st.apply(
            &sign(
                submitted_message(&s, DAY, 3, &ORDER, &NONCE, &[6; 32], 0).unwrap(),
                &a.seller,
            ),
            DAY,
        )
        .unwrap();
        assert_eq!(st.stage, Stage::Released);
    }

    #[test]
    fn release_requires_nonzero_inputs_and_txset_hashes() {
        let (mut st, a) = funded_session();
        let s = a.seller.verifying_key().to_bytes();
        assert!(st
            .apply(
                &sign(
                    release_message(
                        &s, DAY, 2, &ORDER, &NONCE, b"5Seller", 500, &[0; 32], &[5; 32],
                    )
                    .unwrap(),
                    &a.seller,
                ),
                DAY,
            )
            .is_err());
        assert!(st
            .apply(
                &sign(
                    release_message(
                        &s, DAY, 2, &ORDER, &NONCE, b"5Seller", 500, &[4; 32], &[0; 32],
                    )
                    .unwrap(),
                    &a.seller,
                ),
                DAY,
            )
            .is_err());
        assert_eq!(st.stage, Stage::AwaitingSpend);
    }

    #[test]
    fn stored_messages_replay_after_the_freshness_window() {
        let a = Actors::new();
        let b = a.buyer.verifying_key().to_bytes();
        let s = a.seller.verifying_key().to_bytes();
        let r = a.arbiter.verifying_key().to_bytes();
        let signed = sign(
            open_message(&b, DAY, 0, &ORDER, &NONCE, &s, &r, 500, b"XMR").unwrap(),
            &a.buyer,
        );
        assert!(EscrowState::new().apply(&signed, DAY + 100).is_err());
        let mut replay = EscrowState::new();
        replay.apply_replay(&signed).unwrap();
        assert_eq!(replay.stage, Stage::Proposed);
    }

    #[test]
    fn funding_window_is_a_hint_only_and_cannot_replace_a_signed_cancel() {
        let a = Actors::new();
        let b = a.buyer.verifying_key().to_bytes();
        let s = a.seller.verifying_key().to_bytes();
        let r = a.arbiter.verifying_key().to_bytes();
        let mut st = EscrowState::new();
        st.apply(
            &sign(
                open_message(&b, DAY, 0, &ORDER, &NONCE, &s, &r, 500, b"XMR").unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        assert!(!st.funding_expired(DAY + FUNDING_DAYS - 1));
        assert!(st.funding_expired(DAY + FUNDING_DAYS));
        // A hint must never desync replay: the stage is still Proposed and a
        // valid join remains acceptable after the window has passed.
        assert_eq!(st.stage, Stage::Proposed);
        st.apply(
            &sign(
                join_message(&b, DAY, 1, &ORDER, &NONCE, 0, b"b").unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        assert!(st.funding_expired(DAY + FUNDING_DAYS));
        st.apply(
            &sign(
                cancel_message(&b, DAY, 2, &ORDER, &NONCE, 0).unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        assert_eq!(st.stage, Stage::Cancelled);
    }

    #[test]
    fn commit_rejects_an_undeclared_transcript_hash() {
        let a = Actors::new();
        let b = a.buyer.verifying_key().to_bytes();
        let s = a.seller.verifying_key().to_bytes();
        let r = a.arbiter.verifying_key().to_bytes();
        let mut st = EscrowState::new();
        st.apply(
            &sign(
                open_message(&b, DAY, 0, &ORDER, &NONCE, &s, &r, 500, b"XMR").unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        for (actor, key, role, seq) in [
            (&b, &a.buyer, 0, 1),
            (&s, &a.seller, 1, 0),
            (&r, &a.arbiter, 2, 0),
        ] {
            st.apply(
                &sign(
                    join_message(actor, DAY, seq, &ORDER, &NONCE, role, b"j").unwrap(),
                    key,
                ),
                DAY,
            )
            .unwrap();
        }
        assert_eq!(st.stage, Stage::Joined);
        st.apply(
            &sign(
                commit_message(&b, DAY, 2, &ORDER, &NONCE, 3, ADDR, &transcript()).unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        let forged = sign(
            commit_message(&s, DAY, 1, &ORDER, &NONCE, 3, ADDR, &[0x99; 32]).unwrap(),
            &a.seller,
        );
        assert!(st.apply(&forged, DAY).is_err());
        assert_eq!(st.stage, Stage::Joined);
        // No sequence slot or commit slot was consumed by the forged hash.
        st.apply(
            &sign(
                commit_message(&s, DAY, 1, &ORDER, &NONCE, 3, ADDR, &transcript()).unwrap(),
                &a.seller,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                commit_message(&r, DAY, 1, &ORDER, &NONCE, 3, ADDR, &transcript()).unwrap(),
                &a.arbiter,
            ),
            DAY,
        )
        .unwrap();
        assert_eq!(st.stage, Stage::Setup);
    }

    #[test]
    fn funding_amount_and_second_signature_are_enforced() {
        let (mut setup, a) = setup_session();
        let b = a.buyer.verifying_key().to_bytes();
        assert!(setup
            .apply(
                &sign(
                    funded_message(&b, DAY, 3, &ORDER, &NONCE, &[7; 32], 499, b"proof").unwrap(),
                    &a.buyer,
                ),
                DAY,
            )
            .is_err());
        assert_eq!(setup.stage, Stage::Setup);

        let (mut st, a) = funded_session();
        let b = a.buyer.verifying_key().to_bytes();
        let s = a.seller.verifying_key().to_bytes();

        let release = sign(
            release_message(
                &s, DAY, 2, &ORDER, &NONCE, b"5Seller", 500, &[4; 32], &[5; 32],
            )
            .unwrap(),
            &a.seller,
        );
        let digest = crate::message::digest(&release);
        st.apply(&release, DAY).unwrap();

        // The seller's release alone is not two signatures.
        assert!(st
            .apply(
                &sign(
                    submitted_message(&s, DAY, 3, &ORDER, &NONCE, &[6; 32], 0).unwrap(),
                    &a.seller,
                ),
                DAY,
            )
            .is_err());
        st.apply(
            &sign(
                approve_message(&b, DAY, 4, &ORDER, &NONCE, &digest, 0).unwrap(),
                &a.buyer,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                submitted_message(&s, DAY, 3, &ORDER, &NONCE, &[6; 32], 0).unwrap(),
                &a.seller,
            ),
            DAY,
        )
        .unwrap();
        assert_eq!(st.stage, Stage::Released);
    }

    #[test]
    fn resolved_payout_cannot_broadcast_without_arbiter_approval() {
        let (mut st, a) = funded_session();
        let b = a.buyer.verifying_key().to_bytes();
        let s = a.seller.verifying_key().to_bytes();
        let r = a.arbiter.verifying_key().to_bytes();
        let dispute = sign(
            dispute_message(&b, DAY, 4, &ORDER, &NONCE, 1, b"not delivered").unwrap(),
            &a.buyer,
        );
        let dispute_digest = crate::message::digest(&dispute);
        st.apply(&dispute, DAY).unwrap();
        st.apply(
            &sign(
                resolve_message(
                    &r,
                    DAY,
                    2,
                    &ORDER,
                    &NONCE,
                    &dispute_digest,
                    0,
                    b"5Seller",
                    &[7; 32],
                )
                .unwrap(),
                &a.arbiter,
            ),
            DAY,
        )
        .unwrap();
        let release = sign(
            release_message(
                &s, DAY, 3, &ORDER, &NONCE, b"5Seller", 500, &[7; 32], &[8; 32],
            )
            .unwrap(),
            &a.seller,
        );
        st.apply(&release, DAY).unwrap();
        assert!(st
            .apply(
                &sign(
                    submitted_message(&s, DAY, 4, &ORDER, &NONCE, &[9; 32], 0).unwrap(),
                    &a.seller,
                ),
                DAY,
            )
            .is_err());
        st.apply(
            &sign(
                approve_message(
                    &r,
                    DAY,
                    3,
                    &ORDER,
                    &NONCE,
                    &crate::message::digest(&release),
                    2,
                )
                .unwrap(),
                &a.arbiter,
            ),
            DAY,
        )
        .unwrap();
        st.apply(
            &sign(
                submitted_message(&s, DAY, 4, &ORDER, &NONCE, &[9; 32], 0).unwrap(),
                &a.seller,
            ),
            DAY,
        )
        .unwrap();
        assert_eq!(st.stage, Stage::Released);
    }

    /// Complete happy-path log, in acceptance order, for replay tests.
    fn lifecycle_messages() -> Vec<Vec<u8>> {
        let a = Actors::new();
        let b = a.buyer.verifying_key().to_bytes();
        let s = a.seller.verifying_key().to_bytes();
        let r = a.arbiter.verifying_key().to_bytes();
        let release = sign(
            release_message(
                &s, DAY, 2, &ORDER, &NONCE, b"5Seller", 500, &[4; 32], &[5; 32],
            )
            .unwrap(),
            &a.seller,
        );
        let approve = sign(
            approve_message(
                &b,
                DAY,
                4,
                &ORDER,
                &NONCE,
                &crate::message::digest(&release),
                0,
            )
            .unwrap(),
            &a.buyer,
        );
        vec![
            sign(
                open_message(&b, DAY, 0, &ORDER, &NONCE, &s, &r, 500, b"XMR").unwrap(),
                &a.buyer,
            ),
            sign(
                join_message(&b, DAY, 1, &ORDER, &NONCE, 0, b"b").unwrap(),
                &a.buyer,
            ),
            sign(
                join_message(&s, DAY, 0, &ORDER, &NONCE, 1, b"s").unwrap(),
                &a.seller,
            ),
            sign(
                join_message(&r, DAY, 0, &ORDER, &NONCE, 2, b"r").unwrap(),
                &a.arbiter,
            ),
            sign(
                commit_message(&b, DAY, 2, &ORDER, &NONCE, 3, ADDR, &transcript()).unwrap(),
                &a.buyer,
            ),
            sign(
                commit_message(&s, DAY, 1, &ORDER, &NONCE, 3, ADDR, &transcript()).unwrap(),
                &a.seller,
            ),
            sign(
                commit_message(&r, DAY, 1, &ORDER, &NONCE, 3, ADDR, &transcript()).unwrap(),
                &a.arbiter,
            ),
            sign(
                funded_message(&b, DAY, 3, &ORDER, &NONCE, &HASH, 500, b"proof").unwrap(),
                &a.buyer,
            ),
            release,
            approve,
            sign(
                submitted_message(&s, DAY, 3, &ORDER, &NONCE, &[6; 32], 0).unwrap(),
                &a.seller,
            ),
        ]
    }

    #[test]
    fn a_full_log_replays_to_the_same_stage() {
        let messages = lifecycle_messages();
        let mut live = EscrowState::new();
        for msg in &messages {
            live.apply(msg, DAY).unwrap();
        }
        assert_eq!(live.stage, Stage::Released);

        // Rebuild from the signed envelopes only, with no freshness window.
        let mut replay = EscrowState::new();
        for msg in &messages {
            replay.apply_replay(msg).unwrap();
        }
        assert_eq!(replay.stage, Stage::Released);
        assert_eq!(replay.release_txset_hash(), live.release_txset_hash());
    }
}
