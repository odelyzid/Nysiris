//! Signature scheme for fly-social (byte-exact, cross-implementation).
//!
//! Identity = ed25519 keypair. The 32-byte public key IS the username. Every
//! write is signed; the provider verifies before storing, and any client can
//! re-verify on read. Unsigned writes are dropped.
//!
//! Domains (domain-separated, concatenation, no length prefixes — fields are
//! all fixed-size except the body, which is always last):
//!
//! ```text
//! post:    b"fly-social-v1/post"    || author(32) || day_be64 || parent(16) || body
//! profile: b"fly-social-v1/profile" || author(32) || name || 0x00 || bio
//! ```
//!
//! `parent` is the 16-byte id of the post being replied to, or all zeros for
//! a top-level post. Fixed-size, so the no-length-prefix scheme is preserved
//! and the body stays last. Replies are plain posts with a parent set: the
//! service stores + verifies the field and never assembles threads.
//!
//! `day` is a coarse UTC day number (`unix_time / 86400`), not a timestamp:
//! the server never sees precise times. The same construction must be used by
//! the browser client (`web/src/social/identity.ts`).

use ed25519_dalek::{Signature, Verifier, VerifyingKey};

#[cfg(test)]
use ed25519_dalek::{Signer, SigningKey};

pub const POST_DOMAIN: &[u8] = b"fly-social-v1/post";
pub const PROFILE_DOMAIN: &[u8] = b"fly-social-v1/profile";

/// Current UTC day number (coarse time for posts/profiles).
pub fn current_day() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0)
}

pub fn post_message(author: &[u8; 32], day: u64, body: &[u8], parent: Option<&[u8; 16]>) -> Vec<u8> {
    let mut m = Vec::with_capacity(POST_DOMAIN.len() + 32 + 8 + 16 + body.len());
    m.extend_from_slice(POST_DOMAIN);
    m.extend_from_slice(author);
    m.extend_from_slice(&day.to_be_bytes());
    // Absent parent signs as sixteen zero bytes: top-level posts are just
    // replies to nothing, under the same domain.
    m.extend_from_slice(parent.unwrap_or(&[0u8; 16]));
    m.extend_from_slice(body);
    m
}

pub fn profile_message(author: &[u8; 32], name: &str, bio: &str) -> Vec<u8> {
    let mut m = Vec::with_capacity(PROFILE_DOMAIN.len() + 32 + name.len() + 1 + bio.len());
    m.extend_from_slice(PROFILE_DOMAIN);
    m.extend_from_slice(author);
    m.extend_from_slice(name.as_bytes());
    m.push(0x00);
    m.extend_from_slice(bio.as_bytes());
    m
}

pub fn parse_pubkey(hex_str: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(hex_str.trim()).map_err(|e| format!("pubkey not hex: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("pubkey must be 32 bytes, got {}", bytes.len()));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    // Reject non-canonical and small-order points up front so bad keys fail
    // fast, not deep in SQL. (Small-order keys have known discrete logs, so
    // anyone could sign as that "identity".)
    let key = VerifyingKey::from_bytes(&out).map_err(|e| format!("bad ed25519 point: {e}"))?;
    if key.is_weak() {
        return Err("weak (small-order) ed25519 key".into());
    }
    Ok(out)
}

pub fn parse_sig(hex_str: &str) -> Result<Signature, String> {
    let bytes = hex::decode(hex_str.trim()).map_err(|e| format!("sig not hex: {e}"))?;
    if bytes.len() != 64 {
        return Err(format!("sig must be 64 bytes, got {}", bytes.len()));
    }
    let mut arr = [0u8; 64];
    arr.copy_from_slice(&bytes);
    Ok(Signature::from_bytes(&arr))
}

pub fn verify(author: &[u8; 32], message: &[u8], sig: &Signature) -> Result<(), String> {
    let key = VerifyingKey::from_bytes(author).map_err(|e| format!("bad key: {e}"))?;
    key.verify(message, sig).map_err(|e| format!("bad signature: {e}"))
}

/// Test helper: sign with a raw 32-byte secret.
#[cfg(test)]
pub fn sign_with(secret: &[u8; 32], message: &[u8]) -> (SigningKey, Signature) {
    let sk = SigningKey::from_bytes(secret);
    let sig = sk.sign(message);
    (sk, sig)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_verify_round_trip_with_fixed_vector() {
        let secret = [7u8; 32];
        let author = SigningKey::from_bytes(&secret).verifying_key().to_bytes();
        let msg = post_message(&author, 20400, b"hello mixnet", None);
        let (_, sig) = sign_with(&secret, &msg);
        verify(&author, &msg, &sig).unwrap();

        // Tampered body fails.
        let bad = post_message(&author, 20400, b"hello mixneT", None);
        assert!(verify(&author, &bad, &sig).is_err());
        // Wrong day fails (replay into another day bucket fails).
        let other_day = post_message(&author, 20401, b"hello mixnet", None);
        assert!(verify(&author, &other_day, &sig).is_err());
    }

    #[test]
    fn reply_parent_is_bound_into_the_signature() {
        let secret = [7u8; 32];
        let author = SigningKey::from_bytes(&secret).verifying_key().to_bytes();
        let parent = [9u8; 16];
        let msg = post_message(&author, 20400, b"a reply", Some(&parent));
        let (_, sig) = sign_with(&secret, &msg);
        verify(&author, &msg, &sig).unwrap();
        // Same bytes as a top-level post do NOT verify under the reply sig…
        let top = post_message(&author, 20400, b"a reply", None);
        assert!(verify(&author, &top, &sig).is_err());
        // …and vice versa: the parent can't be stripped or swapped.
        let other = post_message(&author, 20400, b"a reply", Some(&[1u8; 16]));
        assert!(verify(&author, &other, &sig).is_err());
    }

    #[test]
    fn rejects_malformed_keys() {
        assert!(parse_pubkey("zz").is_err());
        assert!(parse_pubkey(&"00".repeat(31)).is_err());
        // 32 zero bytes are not a valid ed25519 point (low-order identity).
        assert!(parse_pubkey(&"00".repeat(32)).is_err());
        assert!(parse_sig(&"ab".repeat(63)).is_err());
    }
}
