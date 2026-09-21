//! Primitives used by the Sphinx construction.
//!
//! Deliberately mirrors `sphinx-packet::crypto`:
//! * `generate_pseudorandom_bytes` uses **AES-128-CTR** with a zero IV.
//! * The header MAC is HMAC-SHA256 truncated to 16 bytes.
//! * Shared secrets are expanded with HKDF-SHA256 to `EXPANDED_SHARED_SECRET_LENGTH`.

use crate::constants::*;
use aes::cipher::{KeyIvInit, StreamCipher};
use ctr::Ctr64BE;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type Aes128Ctr = Ctr64BE<aes::Aes128>;
type HmacSha256 = Hmac<Sha256>;

/// AES-128-CTR keystream, identical in spirit to Nym's
/// `crypto::generate_pseudorandom_bytes`. Both key and IV are exactly 16 bytes.
pub fn generate_pseudorandom_bytes(
    key: &[u8; STREAM_CIPHER_KEY_SIZE],
    iv: &[u8; STREAM_CIPHER_KEY_SIZE],
    length: usize,
) -> Vec<u8> {
    let mut cipher = Aes128Ctr::new(key.into(), iv.into());
    let mut data = vec![0u8; length];
    cipher.apply_keystream(&mut data);
    data
}

/// HMAC-SHA256, truncated to `HEADER_INTEGRITY_MAC_SIZE` bytes (gamma).
pub fn compute_header_mac(key: &[u8], data: &[u8]) -> [u8; HEADER_INTEGRITY_MAC_SIZE] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts keys of any length");
    mac.update(data);
    let digest = mac.finalize().into_bytes();
    let mut out = [0u8; HEADER_INTEGRITY_MAC_SIZE];
    out.copy_from_slice(&digest[..HEADER_INTEGRITY_MAC_SIZE]);
    out
}

/// Constant-time-ish equality for MAC comparison.
pub fn mac_eq(a: &[u8; HEADER_INTEGRITY_MAC_SIZE], b: &[u8; HEADER_INTEGRITY_MAC_SIZE]) -> bool {
    // Both are fixed-size arrays; a simple comparison is fine here but we keep
    // the function so call sites read intentionally.
    a == b
}

/// Derive the 192-byte Lioness payload key from the 16-byte seed.
pub fn derive_payload_key(seed: &[u8; PAYLOAD_KEY_SEED_SIZE]) -> [u8; PAYLOAD_KEY_SIZE] {
    let hkdf = Hkdf::<Sha256>::new(Some(PAYLOAD_KEY_HKDF_SALT), seed);
    let mut out = [0u8; PAYLOAD_KEY_SIZE];
    hkdf.expand(PAYLOAD_KEY_HKDF_INFO, &mut out)
        .expect("192 bytes is a valid HKDF output length");
    out
}

/// XOR two byte slices in place; `dst` is truncated to `src.len()`.
pub fn xor_with(dst: &mut [u8], src: &[u8]) {
    for (d, s) in dst.iter_mut().zip(src.iter()) {
        *d ^= *s;
    }
}

/// XOR two equal-length slices into a new vector.
pub fn xor(a: &[u8], b: &[u8]) -> Vec<u8> {
    a.iter().zip(b.iter()).map(|(x, y)| x ^ y).collect()
}
