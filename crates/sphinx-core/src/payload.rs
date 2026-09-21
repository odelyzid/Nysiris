//! Sphinx payload: `delta`.
//!
//! Payload protection uses the **Lioness wide-block cipher** (BLAKE2b + ChaCha)
//! exactly as Nym does. A wide-block cipher is essential: flipping any bit of
//! the ciphertext randomises the *entire* plaintext, so a malicious mix node
//! cannot surgically target the padding delimiter or the application message.
//!
//! Layout of the decrypted buffer:
//!
//! ```text
//! [ 16 zero bytes ] [ message ] [ 0x01 ] [ zero padding ... ]   total 2065
//! ```
//!
//! The 0x01 marks the end of the message; the leading zeros let the receiver
//! distinguish a decoded layer from a corrupt one.

use crate::constants::*;
use crate::crypto::derive_payload_key;
use crate::error::{SphinxError, SphinxResult};
use blake2::VarBlake2b;
use chacha::ChaCha;
use lioness::Lioness;

/// An encrypted (or, before the first layer, plaintext) payload buffer.
#[derive(Clone, PartialEq, Eq)]
pub struct Payload(Vec<u8>);

impl Payload {
    /// Build the innermost payload, then wrap it in one Lioness layer per key.
    ///
    /// `payload_keys` must be ordered outermost-first (hop 0 ... final hop), so
    /// encryption is applied in reverse.
    pub fn build(message: &[u8], payload_keys: &[[u8; PAYLOAD_KEY_SIZE]]) -> SphinxResult<Self> {
        let max_message = DEFAULT_PAYLOAD_SIZE - PAYLOAD_OVERHEAD_SIZE;
        if message.len() > max_message {
            return Err(SphinxError::MessageTooLarge(message.len()));
        }

        // set_final_payload: zeros || message || 0x01 || zeros
        let mut buf = vec![0u8; DEFAULT_PAYLOAD_SIZE];
        buf[SECURITY_PARAMETER..SECURITY_PARAMETER + message.len()].copy_from_slice(message);
        buf[SECURITY_PARAMETER + message.len()] = 1;

        let mut payload = Self(buf);
        for key in payload_keys.iter().rev() {
            payload = payload.add_encryption_layer(key)?;
        }
        Ok(payload)
    }

    fn lioness(key: &[u8; PAYLOAD_KEY_SIZE]) -> Lioness<VarBlake2b, ChaCha> {
        Lioness::<VarBlake2b, ChaCha>::new_raw(key)
    }

    fn add_encryption_layer(self, key: &[u8; PAYLOAD_KEY_SIZE]) -> SphinxResult<Self> {
        let mut buf = self.0;
        Self::lioness(key)
            .encrypt(&mut buf)
            .map_err(|_| SphinxError::PayloadDecryptionFailed)?;
        Ok(Self(buf))
    }

    /// Remove one layer of encryption. This is what a mix node does with the
    /// payload key it derived from the header.
    pub fn unwrap_layer(self, key: &[u8; PAYLOAD_KEY_SIZE]) -> SphinxResult<Self> {
        let mut buf = self.0;
        Self::lioness(key)
            .decrypt(&mut buf)
            .map_err(|_| SphinxError::PayloadDecryptionFailed)?;
        Ok(Self(buf))
    }

    /// Encode a message using a pre-computed single-layer key (used by SURBs).
    pub fn encrypt_with_single_key(
        message: &[u8],
        key: &[u8; PAYLOAD_KEY_SIZE],
    ) -> SphinxResult<Self> {
        let mut buf = vec![0u8; DEFAULT_PAYLOAD_SIZE];
        let max_message = DEFAULT_PAYLOAD_SIZE - PAYLOAD_OVERHEAD_SIZE;
        if message.len() > max_message {
            return Err(SphinxError::MessageTooLarge(message.len()));
        }
        buf[SECURITY_PARAMETER..SECURITY_PARAMETER + message.len()].copy_from_slice(message);
        buf[SECURITY_PARAMETER + message.len()] = 1;
        Self::lioness(key)
            .encrypt(&mut buf)
            .map_err(|_| SphinxError::PayloadDecryptionFailed)?;
        Ok(Self(buf))
    }

    /// After all layers are removed, recover the original message.
    pub fn recover_plaintext(&self) -> SphinxResult<Vec<u8>> {
        if self.0.len() < PAYLOAD_OVERHEAD_SIZE {
            return Err(SphinxError::MalformedPayload("too short"));
        }
        if !self.0[..SECURITY_PARAMETER].iter().all(|b| *b == 0) {
            return Err(SphinxError::MalformedPayload(
                "missing leading zero padding (wrong key or corrupt packet)",
            ));
        }
        let padded = &self.0[SECURITY_PARAMETER..];
        let delimiter = padded
            .iter()
            .rposition(|b| *b == 1)
            .ok_or(SphinxError::MalformedPayload("no padding delimiter"))?;
        Ok(padded[..delimiter].to_vec())
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn from_bytes(bytes: &[u8]) -> SphinxResult<Self> {
        if bytes.len() != DEFAULT_PAYLOAD_SIZE {
            return Err(SphinxError::InvalidPacketLength(bytes.len()));
        }
        Ok(Self(bytes.to_vec()))
    }
}

/// Convenience: derive a Lioness key from a raw seed (used by SURB pools).
pub fn payload_key_from_seed(seed: &[u8; PAYLOAD_KEY_SEED_SIZE]) -> [u8; PAYLOAD_KEY_SIZE] {
    derive_payload_key(seed)
}
