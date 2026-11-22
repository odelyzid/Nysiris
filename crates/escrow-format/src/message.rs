//! Signed envelopes for the stagenet escrow reference (doc 17).
//!
//! Layout: `domain(24, NUL-padded) || actor(32) || day_be64 || seq_be64 ||
//! payload || sig(64)`. The signature covers every byte before `sig`.
//! Fixed-size fields come first; variable fields carry a `u16` byte length.
//! No float, no JSON, no ambiguous concatenation.

use crate::limits::{MAX_ADDRESS_BYTES, MAX_BLOB_BYTES, MAX_BODY_BYTES, MAX_PROOF_BYTES, MAX_SEQ};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest as _, Sha256};

const DOMAIN_LEN: usize = 24;

pub const OPEN_DOMAIN: &[u8] = b"fly-escrow-v1/open";
pub const JOIN_DOMAIN: &[u8] = b"fly-escrow-v1/join";
pub const COMMIT_DOMAIN: &[u8] = b"fly-escrow-v1/commit";
pub const FUNDED_DOMAIN: &[u8] = b"fly-escrow-v1/funded";
pub const RELEASE_DOMAIN: &[u8] = b"fly-escrow-v1/release";
pub const APPROVE_DOMAIN: &[u8] = b"fly-escrow-v1/approve";
pub const DISPUTE_DOMAIN: &[u8] = b"fly-escrow-v1/dispute";
pub const RESOLVE_DOMAIN: &[u8] = b"fly-escrow-v1/resolve";
pub const CANCEL_DOMAIN: &[u8] = b"fly-escrow-v1/cancel";
pub const SUBMITTED_DOMAIN: &[u8] = b"fly-escrow-v1/submitted";

/// Current UTC day number (coarse time, as in the shop protocol).
pub fn current_day() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0)
}

/// SHA-256 of a signed envelope or opaque wallet blob, used for all digests.
pub fn digest(bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&h.finalize());
    out
}

/// Final setup transcript: `SHA-256(order || nonce || escrow_address)`.
///
/// Every participant derives this independently from the signed shop order,
/// the fresh session nonce, and the address all three wallets agree on. A
/// client must never accept a `commit` carrying a hash chosen by one party.
/// The same byte sequence is used by the stagenet harness and the web mirror.
pub fn setup_transcript_hash(order: &[u8; 16], nonce: &[u8; 16], address: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(order);
    h.update(nonce);
    h.update(address);
    let mut out = [0u8; 32];
    out.copy_from_slice(&h.finalize());
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Domain {
    Open,
    Join,
    Commit,
    Funded,
    Release,
    Approve,
    Dispute,
    Resolve,
    Cancel,
    Submitted,
}

impl Domain {
    pub fn name(self) -> &'static [u8] {
        match self {
            Self::Open => OPEN_DOMAIN,
            Self::Join => JOIN_DOMAIN,
            Self::Commit => COMMIT_DOMAIN,
            Self::Funded => FUNDED_DOMAIN,
            Self::Release => RELEASE_DOMAIN,
            Self::Approve => APPROVE_DOMAIN,
            Self::Dispute => DISPUTE_DOMAIN,
            Self::Resolve => RESOLVE_DOMAIN,
            Self::Cancel => CANCEL_DOMAIN,
            Self::Submitted => SUBMITTED_DOMAIN,
        }
    }

    fn padded(self) -> [u8; DOMAIN_LEN] {
        let mut out = [0u8; DOMAIN_LEN];
        let name = self.name();
        assert!(name.len() <= DOMAIN_LEN, "escrow domain too long");
        out[..name.len()].copy_from_slice(name);
        out
    }

    fn from_padded(raw: &[u8; DOMAIN_LEN]) -> Option<Self> {
        [
            Self::Open,
            Self::Join,
            Self::Commit,
            Self::Funded,
            Self::Release,
            Self::Approve,
            Self::Dispute,
            Self::Resolve,
            Self::Cancel,
            Self::Submitted,
        ]
        .into_iter()
        .find(|d| &d.padded() == raw)
    }
}

/// A parsed signed envelope. `payload` borrows from the input buffer.
#[derive(Debug, Clone)]
pub struct Envelope<'a> {
    pub domain: Domain,
    pub actor: [u8; 32],
    pub day: u64,
    pub seq: u64,
    pub payload: &'a [u8],
}

fn take<const N: usize>(src: &[u8], at: &mut usize) -> Result<[u8; N], String> {
    let end = at.checked_add(N).ok_or("offset overflow")?;
    let slice = src.get(*at..end).ok_or("truncated escrow message")?;
    let mut out = [0u8; N];
    out.copy_from_slice(slice);
    *at = end;
    Ok(out)
}

fn split<'a>(src: &'a [u8], at: &mut usize, max: usize) -> Result<&'a [u8], String> {
    let len = u16::from_be_bytes(take::<2>(src, at)?) as usize;
    if len > max {
        return Err(format!("variable field of {len} bytes exceeds cap {max}"));
    }
    let end = at.checked_add(len).ok_or("offset overflow")?;
    let slice = src.get(*at..end).ok_or("truncated variable field")?;
    *at = end;
    Ok(slice)
}

fn check_text(bytes: &[u8]) -> Result<(), String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "field is not UTF-8")?;
    if text.contains('\0') {
        return Err("field contains NUL".into());
    }
    Ok(())
}

fn put_var(out: &mut Vec<u8>, bytes: &[u8], max: usize) -> Result<(), String> {
    if bytes.len() > max {
        return Err(format!("field of {} bytes exceeds cap {max}", bytes.len()));
    }
    if bytes.len() > u16::MAX as usize {
        return Err("field exceeds u16 length prefix".into());
    }
    out.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

fn envelope(domain: Domain, actor: &[u8; 32], day: u64, seq: u64, payload: &[u8]) -> Vec<u8> {
    if seq > MAX_SEQ {
        panic!("sequence above MAX_SEQ");
    }
    let mut out = Vec::with_capacity(DOMAIN_LEN + 32 + 8 + 8 + payload.len());
    out.extend_from_slice(&domain.padded());
    out.extend_from_slice(actor);
    out.extend_from_slice(&day.to_be_bytes());
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Append the ed25519 signature, producing the bytes sent on the wire.
pub fn sign_message(unsigned: Vec<u8>, key: &SigningKey) -> Vec<u8> {
    let sig: Signature = key.sign(&unsigned);
    let mut out = unsigned;
    out.extend_from_slice(&sig.to_bytes());
    out
}

/// Verify the signature and parse the envelope. Never trust an unverified byte.
pub fn verify_message(bytes: &[u8]) -> Result<Envelope<'_>, String> {
    if bytes.len() < DOMAIN_LEN + 32 + 8 + 8 + 64 {
        return Err("escrow envelope too short".into());
    }
    let cut = bytes.len() - 64;
    let (preimage, sig_bytes) = bytes.split_at(cut);
    let sig = Signature::from_slice(sig_bytes).map_err(|e| format!("bad signature: {e}"))?;
    let raw_domain: [u8; DOMAIN_LEN] = preimage[..DOMAIN_LEN]
        .try_into()
        .map_err(|_| "bad domain")?;
    let domain = Domain::from_padded(&raw_domain).ok_or("unknown escrow domain")?;
    let actor: [u8; 32] = preimage[DOMAIN_LEN..DOMAIN_LEN + 32]
        .try_into()
        .map_err(|_| "bad actor")?;
    let vk = VerifyingKey::from_bytes(&actor).map_err(|e| format!("bad actor key: {e}"))?;
    vk.verify(preimage, &sig)
        .map_err(|_| "escrow signature does not verify")?;
    let day = u64::from_be_bytes(
        preimage[DOMAIN_LEN + 32..DOMAIN_LEN + 40]
            .try_into()
            .map_err(|_| "bad day")?,
    );
    let seq = u64::from_be_bytes(
        preimage[DOMAIN_LEN + 40..DOMAIN_LEN + 48]
            .try_into()
            .map_err(|_| "bad seq")?,
    );
    if seq > MAX_SEQ {
        return Err("sequence above MAX_SEQ".into());
    }
    Ok(Envelope {
        domain,
        actor,
        day,
        seq,
        payload: &preimage[DOMAIN_LEN + 48..],
    })
}

/// Parse only the envelope header (for size/order checks before verification).
pub fn parse_header(bytes: &[u8]) -> Result<Envelope<'_>, String> {
    if bytes.len() < DOMAIN_LEN + 32 + 8 + 8 + 64 {
        return Err("escrow envelope too short".into());
    }
    let cut = bytes.len() - 64;
    let preimage = &bytes[..cut];
    let raw_domain: [u8; DOMAIN_LEN] = preimage[..DOMAIN_LEN]
        .try_into()
        .map_err(|_| "bad domain")?;
    let domain = Domain::from_padded(&raw_domain).ok_or("unknown escrow domain")?;
    let actor: [u8; 32] = preimage[DOMAIN_LEN..DOMAIN_LEN + 32]
        .try_into()
        .map_err(|_| "bad actor")?;
    let day = u64::from_be_bytes(
        preimage[DOMAIN_LEN + 32..DOMAIN_LEN + 40]
            .try_into()
            .map_err(|_| "bad day")?,
    );
    let seq = u64::from_be_bytes(
        preimage[DOMAIN_LEN + 40..DOMAIN_LEN + 48]
            .try_into()
            .map_err(|_| "bad seq")?,
    );
    Ok(Envelope {
        domain,
        actor,
        day,
        seq,
        payload: &preimage[DOMAIN_LEN + 48..],
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decoded {
    Open {
        order: [u8; 16],
        nonce: [u8; 16],
        seller: [u8; 32],
        arbiter: [u8; 32],
        amount: u64,
        currency: [u8; 3],
    },
    Join {
        order: [u8; 16],
        nonce: [u8; 16],
        role: u8,
        blob: Vec<u8>,
    },
    Commit {
        order: [u8; 16],
        nonce: [u8; 16],
        round: u8,
        address: Vec<u8>,
        transcript_hash: [u8; 32],
    },
    Funded {
        order: [u8; 16],
        nonce: [u8; 16],
        txid: [u8; 32],
        amount: u64,
        proof: Vec<u8>,
    },
    Release {
        order: [u8; 16],
        nonce: [u8; 16],
        payout: Vec<u8>,
        amount: u64,
        inputs_hash: [u8; 32],
        txset_hash: [u8; 32],
    },
    Approve {
        order: [u8; 16],
        nonce: [u8; 16],
        release_digest: [u8; 32],
        role: u8,
    },
    Dispute {
        order: [u8; 16],
        nonce: [u8; 16],
        reason: u8,
        body: Vec<u8>,
    },
    Resolve {
        order: [u8; 16],
        nonce: [u8; 16],
        dispute_digest: [u8; 32],
        decision: u8,
        payout: Vec<u8>,
        inputs_hash: [u8; 32],
    },
    Cancel {
        order: [u8; 16],
        nonce: [u8; 16],
        reason: u8,
    },
    Submitted {
        order: [u8; 16],
        nonce: [u8; 16],
        txid: [u8; 32],
        kind: u8,
    },
}

/// Decode a verified envelope's payload. Unknown or malformed fields are
/// rejected here, never coerced to defaults.
pub fn decode(env: &Envelope<'_>) -> Result<Decoded, String> {
    let b = env.payload;
    let mut i = 0usize;
    let order = take::<16>(b, &mut i)?;
    let nonce = take::<16>(b, &mut i)?;
    let decoded = match env.domain {
        Domain::Open => {
            let seller = take::<32>(b, &mut i)?;
            let arbiter = take::<32>(b, &mut i)?;
            let amount = u64::from_be_bytes(take::<8>(b, &mut i)?);
            let currency = take::<3>(b, &mut i)?;
            if !currency.iter().all(u8::is_ascii_uppercase) {
                return Err("currency must be 3 uppercase ASCII letters".into());
            }
            Decoded::Open {
                order,
                nonce,
                seller,
                arbiter,
                amount,
                currency,
            }
        }
        Domain::Join => {
            let role = take::<1>(b, &mut i)?[0];
            if role > 2 {
                return Err("unknown escrow role".into());
            }
            let blob = split(b, &mut i, MAX_BLOB_BYTES)?.to_vec();
            Decoded::Join {
                order,
                nonce,
                role,
                blob,
            }
        }
        Domain::Commit => {
            let round = take::<1>(b, &mut i)?[0];
            if round == 0 || round > 3 {
                return Err("unknown multisig setup round".into());
            }
            let address = split(b, &mut i, MAX_ADDRESS_BYTES)?.to_vec();
            check_text(&address)?;
            let transcript_hash = take::<32>(b, &mut i)?;
            Decoded::Commit {
                order,
                nonce,
                round,
                address,
                transcript_hash,
            }
        }
        Domain::Funded => {
            let txid = take::<32>(b, &mut i)?;
            let amount = u64::from_be_bytes(take::<8>(b, &mut i)?);
            let proof = split(b, &mut i, MAX_PROOF_BYTES)?.to_vec();
            if proof.is_empty() {
                return Err("empty transaction proof".into());
            }
            Decoded::Funded {
                order,
                nonce,
                txid,
                amount,
                proof,
            }
        }
        Domain::Release => {
            let payout = split(b, &mut i, MAX_ADDRESS_BYTES)?.to_vec();
            check_text(&payout)?;
            if payout.is_empty() {
                return Err("empty payout address".into());
            }
            let amount = u64::from_be_bytes(take::<8>(b, &mut i)?);
            let inputs_hash = take::<32>(b, &mut i)?;
            let txset_hash = take::<32>(b, &mut i)?;
            Decoded::Release {
                order,
                nonce,
                payout,
                amount,
                inputs_hash,
                txset_hash,
            }
        }
        Domain::Approve => {
            let release_digest = take::<32>(b, &mut i)?;
            let role = take::<1>(b, &mut i)?[0];
            if role > 2 {
                return Err("unknown escrow role".into());
            }
            Decoded::Approve {
                order,
                nonce,
                release_digest,
                role,
            }
        }
        Domain::Dispute => {
            let reason = take::<1>(b, &mut i)?[0];
            let body = split(b, &mut i, MAX_BODY_BYTES)?.to_vec();
            check_text(&body)?;
            Decoded::Dispute {
                order,
                nonce,
                reason,
                body,
            }
        }
        Domain::Resolve => {
            let dispute_digest = take::<32>(b, &mut i)?;
            let decision = take::<1>(b, &mut i)?[0];
            if decision > 1 {
                return Err("unknown dispute decision".into());
            }
            let payout = split(b, &mut i, MAX_ADDRESS_BYTES)?.to_vec();
            check_text(&payout)?;
            if payout.is_empty() {
                return Err("empty payout address".into());
            }
            let inputs_hash = take::<32>(b, &mut i)?;
            Decoded::Resolve {
                order,
                nonce,
                dispute_digest,
                decision,
                payout,
                inputs_hash,
            }
        }
        Domain::Cancel => {
            let reason = take::<1>(b, &mut i)?[0];
            Decoded::Cancel {
                order,
                nonce,
                reason,
            }
        }
        Domain::Submitted => {
            let txid = take::<32>(b, &mut i)?;
            let kind = take::<1>(b, &mut i)?[0];
            if kind > 1 {
                return Err("unknown submitted kind".into());
            }
            Decoded::Submitted {
                order,
                nonce,
                txid,
                kind,
            }
        }
    };
    if i != b.len() {
        return Err("trailing bytes in escrow payload".into());
    }
    Ok(decoded)
}

fn common(order: &[u8; 16], nonce: &[u8; 16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(32);
    out.extend_from_slice(order);
    out.extend_from_slice(nonce);
    out
}

#[allow(clippy::too_many_arguments)]
pub fn open_message(
    actor: &[u8; 32],
    day: u64,
    seq: u64,
    order: &[u8; 16],
    nonce: &[u8; 16],
    seller: &[u8; 32],
    arbiter: &[u8; 32],
    amount: u64,
    currency: &[u8; 3],
) -> Result<Vec<u8>, String> {
    if !currency.iter().all(u8::is_ascii_uppercase) {
        return Err("currency must be 3 uppercase ASCII letters".into());
    }
    let mut p = common(order, nonce);
    p.extend_from_slice(seller);
    p.extend_from_slice(arbiter);
    p.extend_from_slice(&amount.to_be_bytes());
    p.extend_from_slice(currency);
    Ok(envelope(Domain::Open, actor, day, seq, &p))
}

pub fn join_message(
    actor: &[u8; 32],
    day: u64,
    seq: u64,
    order: &[u8; 16],
    nonce: &[u8; 16],
    role: u8,
    blob: &[u8],
) -> Result<Vec<u8>, String> {
    if role > 2 {
        return Err("unknown escrow role".into());
    }
    let mut p = common(order, nonce);
    p.push(role);
    put_var(&mut p, blob, MAX_BLOB_BYTES)?;
    Ok(envelope(Domain::Join, actor, day, seq, &p))
}

#[allow(clippy::too_many_arguments)]
pub fn commit_message(
    actor: &[u8; 32],
    day: u64,
    seq: u64,
    order: &[u8; 16],
    nonce: &[u8; 16],
    round: u8,
    address: &[u8],
    transcript_hash: &[u8; 32],
) -> Result<Vec<u8>, String> {
    if round == 0 || round > 3 {
        return Err("unknown multisig setup round".into());
    }
    check_text(address)?;
    let mut p = common(order, nonce);
    p.push(round);
    put_var(&mut p, address, MAX_ADDRESS_BYTES)?;
    p.extend_from_slice(transcript_hash);
    Ok(envelope(Domain::Commit, actor, day, seq, &p))
}

#[allow(clippy::too_many_arguments)]
pub fn funded_message(
    actor: &[u8; 32],
    day: u64,
    seq: u64,
    order: &[u8; 16],
    nonce: &[u8; 16],
    txid: &[u8; 32],
    amount: u64,
    proof: &[u8],
) -> Result<Vec<u8>, String> {
    if proof.is_empty() {
        return Err("empty transaction proof".into());
    }
    let mut p = common(order, nonce);
    p.extend_from_slice(txid);
    p.extend_from_slice(&amount.to_be_bytes());
    put_var(&mut p, proof, MAX_PROOF_BYTES)?;
    Ok(envelope(Domain::Funded, actor, day, seq, &p))
}

#[allow(clippy::too_many_arguments)]
pub fn release_message(
    actor: &[u8; 32],
    day: u64,
    seq: u64,
    order: &[u8; 16],
    nonce: &[u8; 16],
    payout: &[u8],
    amount: u64,
    inputs_hash: &[u8; 32],
    txset_hash: &[u8; 32],
) -> Result<Vec<u8>, String> {
    check_text(payout)?;
    if payout.is_empty() {
        return Err("empty payout address".into());
    }
    let mut p = common(order, nonce);
    put_var(&mut p, payout, MAX_ADDRESS_BYTES)?;
    p.extend_from_slice(&amount.to_be_bytes());
    p.extend_from_slice(inputs_hash);
    p.extend_from_slice(txset_hash);
    Ok(envelope(Domain::Release, actor, day, seq, &p))
}

pub fn approve_message(
    actor: &[u8; 32],
    day: u64,
    seq: u64,
    order: &[u8; 16],
    nonce: &[u8; 16],
    release_digest: &[u8; 32],
    role: u8,
) -> Result<Vec<u8>, String> {
    if role > 2 {
        return Err("unknown escrow role".into());
    }
    let mut p = common(order, nonce);
    p.extend_from_slice(release_digest);
    p.push(role);
    Ok(envelope(Domain::Approve, actor, day, seq, &p))
}

pub fn dispute_message(
    actor: &[u8; 32],
    day: u64,
    seq: u64,
    order: &[u8; 16],
    nonce: &[u8; 16],
    reason: u8,
    body: &[u8],
) -> Result<Vec<u8>, String> {
    check_text(body)?;
    let mut p = common(order, nonce);
    p.push(reason);
    put_var(&mut p, body, MAX_BODY_BYTES)?;
    Ok(envelope(Domain::Dispute, actor, day, seq, &p))
}

#[allow(clippy::too_many_arguments)]
pub fn resolve_message(
    actor: &[u8; 32],
    day: u64,
    seq: u64,
    order: &[u8; 16],
    nonce: &[u8; 16],
    dispute_digest: &[u8; 32],
    decision: u8,
    payout: &[u8],
    inputs_hash: &[u8; 32],
) -> Result<Vec<u8>, String> {
    if decision > 1 {
        return Err("unknown dispute decision".into());
    }
    check_text(payout)?;
    if payout.is_empty() {
        return Err("empty payout address".into());
    }
    let mut p = common(order, nonce);
    p.extend_from_slice(dispute_digest);
    p.push(decision);
    put_var(&mut p, payout, MAX_ADDRESS_BYTES)?;
    p.extend_from_slice(inputs_hash);
    Ok(envelope(Domain::Resolve, actor, day, seq, &p))
}

pub fn cancel_message(
    actor: &[u8; 32],
    day: u64,
    seq: u64,
    order: &[u8; 16],
    nonce: &[u8; 16],
    reason: u8,
) -> Result<Vec<u8>, String> {
    let mut p = common(order, nonce);
    p.push(reason);
    Ok(envelope(Domain::Cancel, actor, day, seq, &p))
}

pub fn submitted_message(
    actor: &[u8; 32],
    day: u64,
    seq: u64,
    order: &[u8; 16],
    nonce: &[u8; 16],
    txid: &[u8; 32],
    kind: u8,
) -> Result<Vec<u8>, String> {
    if kind > 1 {
        return Err("unknown submitted kind".into());
    }
    let mut p = common(order, nonce);
    p.extend_from_slice(txid);
    p.push(kind);
    Ok(envelope(Domain::Submitted, actor, day, seq, &p))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> SigningKey {
        SigningKey::from_bytes(&[byte; 32])
    }

    fn to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn fixed_cross_implementation_vectors() {
        let sk = key(0x2a);
        let vk = sk.verifying_key().to_bytes();
        let order = [0xab; 16];
        let nonce = [0xcd; 16];
        assert_eq!(
            to_hex(&vk),
            "197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61"
        );
        let open = sign_message(
            open_message(
                &vk,
                20_400,
                7,
                &order,
                &nonce,
                &[0x11; 32],
                &[0x22; 32],
                1_234_000_000_000,
                b"XMR",
            )
            .unwrap(),
            &sk,
        );
        assert_eq!(
            to_hex(&open),
            "666c792d657363726f772d76312f6f70656e000000000000197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d610000000000004fb00000000000000007ababababababababababababababababcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000011f5021b400584d52f0a30687596025e6a9d44a6b591f5d8a568b33ea2771a08c8e33a330053453b5bb5cae6b2ce3c2946e43e75394aface253ee68b66864b273215b9cc48f8e1304"
        );
        let join = sign_message(
            join_message(&vk, 20_400, 8, &order, &nonce, 0, b"MultisigxV2ABC").unwrap(),
            &sk,
        );
        assert_eq!(
            to_hex(&join),
            "666c792d657363726f772d76312f6a6f696e000000000000197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d610000000000004fb00000000000000008ababababababababababababababababcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd00000e4d756c7469736967785632414243c8a6c401e18d29fb33ad294d7f2bf3a2194ea9019e3b471ab2e9a97df15f7f63cb69600816b26df70118b43b971497bd17e684d28253b61b7ec2453790071b06"
        );
        let release = sign_message(
            release_message(
                &vk,
                20_400,
                9,
                &order,
                &nonce,
                b"56Payout",
                1_234_000_000_000,
                &[3; 32],
                &[4; 32],
            )
            .unwrap(),
            &sk,
        );
        assert_eq!(
            to_hex(&release),
            "666c792d657363726f772d76312f72656c65617365000000197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d610000000000004fb00000000000000009ababababababababababababababababcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd000835365061796f75740000011f5021b4000303030303030303030303030303030303030303030303030303030303030303040404040404040404040404040404040404040404040404040404040404040460b2a19638d010b5993b3c806144fa49d9881a9f23fac0e54409245156ad35500b89558297a345c9c457c190192448f983009278caba96adc7db3c27f1345503"
        );
    }

    #[test]
    fn envelope_round_trip_and_signature_tamper() {
        let sk = key(1);
        let vk = sk.verifying_key().to_bytes();
        let unsigned = open_message(
            &vk,
            20_000,
            0,
            &[0x11; 16],
            &[0x22; 16],
            &[3; 32],
            &[4; 32],
            1234,
            b"XMR",
        )
        .unwrap();
        let signed = sign_message(unsigned, &sk);
        let env = verify_message(&signed).unwrap();
        assert_eq!(env.domain, Domain::Open);
        assert_eq!(env.actor, vk);
        assert_eq!(env.day, 20_000);
        assert_eq!(env.seq, 0);
        match decode(&env).unwrap() {
            Decoded::Open { amount, .. } => assert_eq!(amount, 1234),
            _ => panic!("wrong message type"),
        }
        let mut bad = signed.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(verify_message(&bad).is_err());
    }

    #[test]
    fn every_message_type_decodes() {
        let sk = key(9);
        let vk = sk.verifying_key().to_bytes();
        let order = [1; 16];
        let nonce = [2; 16];
        let hash = [7; 32];
        let messages = vec![
            open_message(&vk, 1, 1, &order, &nonce, &[3; 32], &[4; 32], 10, b"XMR").unwrap(),
            join_message(&vk, 1, 2, &order, &nonce, 0, b"MultisigxV2...").unwrap(),
            commit_message(&vk, 1, 3, &order, &nonce, 1, b"5Address", &hash).unwrap(),
            funded_message(&vk, 1, 4, &order, &nonce, &hash, 10, b"InProofV1...").unwrap(),
            release_message(&vk, 1, 5, &order, &nonce, b"5Payout", 10, &hash, &hash).unwrap(),
            approve_message(&vk, 1, 6, &order, &nonce, &hash, 0).unwrap(),
            dispute_message(&vk, 1, 7, &order, &nonce, 1, b"not delivered").unwrap(),
            resolve_message(&vk, 1, 8, &order, &nonce, &hash, 1, b"5Refund", &hash).unwrap(),
            cancel_message(&vk, 1, 9, &order, &nonce, 0).unwrap(),
            submitted_message(&vk, 1, 10, &order, &nonce, &hash, 0).unwrap(),
        ];
        for m in messages {
            let signed = sign_message(m, &sk);
            let env = verify_message(&signed).unwrap();
            decode(&env).unwrap();
        }
    }

    #[test]
    fn malformed_fields_are_rejected_not_defaulted() {
        let sk = key(5);
        let vk = sk.verifying_key().to_bytes();
        let order = [1; 16];
        let nonce = [2; 16];
        assert!(open_message(&vk, 1, 1, &order, &nonce, &[3; 32], &[4; 32], 1, b"usd").is_err());
        assert!(commit_message(&vk, 1, 1, &order, &nonce, 0, b"5Addr", &[0; 32]).is_err());
        assert!(join_message(&vk, 1, 1, &order, &nonce, 3, b"x").is_err());
        assert!(dispute_message(&vk, 1, 1, &order, &nonce, 0, b"has\0nul").is_err());

        let signed = sign_message(
            join_message(&vk, 1, 1, &order, &nonce, 0, b"x").unwrap(),
            &sk,
        );
        let env = verify_message(&signed).unwrap();
        let mut bytes = env.payload.to_vec();
        bytes[33..35].copy_from_slice(&u16::MAX.to_be_bytes());
        let mut forged = Vec::new();
        forged.extend_from_slice(&Domain::Join.padded());
        forged.extend_from_slice(&vk);
        forged.extend_from_slice(&1u64.to_be_bytes());
        forged.extend_from_slice(&1u64.to_be_bytes());
        forged.extend_from_slice(&bytes);
        let forged = sign_message(forged, &sk);
        let env = verify_message(&forged).unwrap();
        assert!(decode(&env).is_err());
    }
}
