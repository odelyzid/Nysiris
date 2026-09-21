//! Nym addressing: there is no DNS.
//!
//! A Nym address is a human-shareable encoding of three 32-byte Curve25519 /
//! Ed25519 keys:
//!
//! ```text
//! <user-identity-key>.<user-encryption-key>@<gateway-identity-key>
//! ```
//!
//! * **identity key** — routes within the recipient's gateway (mailbox id).
//! * **encryption key** — the Sphinx destination address; encrypts the final
//!   Sphinx layer.
//! * **gateway key** — which gateway stores messages for this client.
//!
//! Each component is base58-encoded, so an address is three base58 strings
//! joined by `.` and `@`. This module is the entire "name resolution" layer:
//! anything human-readable is resolved *out of band* into this tuple.

use crate::error::{SphinxError, SphinxResult};
use crate::route::DestinationAddress;

const KEY_LEN: usize = 32;

/// A parsed Nym address.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct NymAddress {
    pub identity: [u8; KEY_LEN],
    pub encryption: [u8; KEY_LEN],
    pub gateway: [u8; KEY_LEN],
}

impl NymAddress {
    /// Parse `<identity>.<encryption>@<gateway>`.
    pub fn parse(input: &str) -> SphinxResult<Self> {
        let (left, gateway_b58) = input
            .split_once('@')
            .ok_or_else(|| SphinxError::InvalidAddress("missing '@<gateway>'".into()))?;
        let (identity_b58, encryption_b58) = left
            .split_once('.')
            .ok_or_else(|| SphinxError::InvalidAddress("missing '<identity>.'".into()))?;

        Ok(Self {
            identity: decode_key(identity_b58, "identity")?,
            encryption: decode_key(encryption_b58, "encryption")?,
            gateway: decode_key(gateway_b58, "gateway")?,
        })
    }

    pub fn encode(&self) -> String {
        format!(
            "{}.{}@{}",
            bs58::encode(self.identity).into_string(),
            bs58::encode(self.encryption).into_string(),
            bs58::encode(self.gateway).into_string()
        )
    }

    /// The Sphinx destination address is the client's encryption key.
    pub fn destination_address(&self) -> DestinationAddress {
        DestinationAddress::from_bytes(self.encryption)
    }

    pub fn gateway_identity(&self) -> [u8; KEY_LEN] {
        self.gateway
    }
}

impl std::fmt::Debug for NymAddress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.encode())
    }
}

impl std::fmt::Display for NymAddress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.encode())
    }
}

fn decode_key(b58: &str, field: &str) -> SphinxResult<[u8; KEY_LEN]> {
    let bytes = bs58::decode(b58)
        .into_vec()
        .map_err(|e| SphinxError::InvalidAddress(format!("{field} is not base58: {e}")))?;
    if bytes.len() != KEY_LEN {
        return Err(SphinxError::InvalidAddress(format!(
            "{field} must decode to {KEY_LEN} bytes, got {}",
            bytes.len()
        )));
    }
    let mut out = [0u8; KEY_LEN];
    out.copy_from_slice(&bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_an_address() {
        let identity = [1u8; 32];
        let encryption = [2u8; 32];
        let gateway = [3u8; 32];
        let address = NymAddress {
            identity,
            encryption,
            gateway,
        };
        let encoded = address.encode();
        let decoded = NymAddress::parse(&encoded).unwrap();
        assert_eq!(address, decoded);
        assert_eq!(decoded.destination_address().to_bytes(), encryption);
    }

    #[test]
    fn rejects_missing_separators() {
        assert!(NymAddress::parse("nope").is_err());
        assert!(NymAddress::parse("a.b").is_err());
    }
}
