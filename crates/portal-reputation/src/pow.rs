//! Client-side proof-of-work.
//!
//! ```text
//! pow_bytes = domain || author(32) || payload_hash(32) || nonce_be64
//! valid     = SHA256(pow_bytes) has `bits` leading zero bits
//! ```
//!
//! Binding author + payload hash means a proof cannot be replayed for another
//! author or another message. Verification is one hash; proving averages
//! 2^bits hashes. At 16 bits a browser proves in well under a second; at 24
//! bits a desktop spends seconds. Providers advertise their difficulty and
//! reject under-proofed writes — see `services/social` (`SOCIAL_POW_BITS`).
//!
//! PoW prices spam; it does not identify anyone and does not stop a funded
//! attacker. That is what rate limits and reputation are for.

use sha2::{Digest, Sha256};

pub const POW_DOMAIN: &[u8] = b"fly-portal-v1/pow";
/// Hard ceiling: difficulties above this are never accepted, so a malicious
/// provider cannot demand years of CPU from honest clients.
pub const MAX_POW_BITS: u32 = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proof {
    pub nonce: u64,
    pub bits: u32,
}

/// Hash the proof preimage.
pub fn hash_proof(author: &[u8; 32], payload_hash: &[u8; 32], nonce: u64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(POW_DOMAIN);
    hasher.update(author);
    hasher.update(payload_hash);
    hasher.update(nonce.to_be_bytes());
    hasher.finalize().into()
}

/// Count leading zero bits of a hash.
pub fn leading_zeros(hash: &[u8; 32]) -> u32 {
    let mut zeros = 0u32;
    for byte in hash {
        if *byte == 0 {
            zeros += 8;
        } else {
            zeros += byte.leading_zeros();
            break;
        }
    }
    zeros
}

/// Verify a proof. Cheap: exactly one hash.
pub fn verify(author: &[u8; 32], payload_hash: &[u8; 32], proof: &Proof) -> bool {
    if proof.bits == 0 || proof.bits > MAX_POW_BITS {
        return false;
    }
    leading_zeros(&hash_proof(author, payload_hash, proof.nonce)) >= proof.bits
}

/// Search nonces from `start`, giving up after `max_attempts`.
/// Returns the first proof meeting `bits`, or None on exhaustion.
pub fn prove(
    author: &[u8; 32],
    payload_hash: &[u8; 32],
    bits: u32,
    start: u64,
    max_attempts: u64,
) -> Option<Proof> {
    if bits == 0 || bits > MAX_POW_BITS || max_attempts == 0 {
        return None;
    }
    let end = start.saturating_add(max_attempts);
    let mut nonce = start;
    while nonce < end {
        if leading_zeros(&hash_proof(author, payload_hash, nonce)) >= bits {
            return Some(Proof { nonce, bits });
        }
        nonce += 1;
    }
    None
}

/// Hash raw bytes into the 32-byte payload commitment proofs bind to.
pub fn payload_hash(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}
