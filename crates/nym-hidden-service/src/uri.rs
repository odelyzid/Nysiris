//! Canonical hidden-service addressing: `nym://<id>.<enc>@<gw>`.
//!
//! The three components are the same keys as a Nym address
//! (`docs/02-addressing-and-routing.md`): client identity, client encryption
//! key, and gateway identity, each base58-encoded 32-byte keys. The `nym://`
//! scheme only makes the string unambiguous in URIs, configs, and QR codes;
//! the bare `id.enc@gw` form parses identically.

use std::fmt;
use std::str::FromStr;

const KEY_LEN: usize = 32;
const SCHEME: &str = "nym://";

/// A parsed hidden-service address.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct NymUri {
    pub identity: [u8; KEY_LEN],
    pub encryption: [u8; KEY_LEN],
    pub gateway: [u8; KEY_LEN],
}

/// Why an address string was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UriError {
    MissingSchemeOrSeparators,
    BadIdentity(String),
    BadEncryption(String),
    BadGateway(String),
}

impl fmt::Display for UriError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UriError::MissingSchemeOrSeparators => {
                write!(f, "expected nym://<identity>.<encryption>@<gateway>")
            }
            UriError::BadIdentity(e) => write!(f, "bad identity key: {e}"),
            UriError::BadEncryption(e) => write!(f, "bad encryption key: {e}"),
            UriError::BadGateway(e) => write!(f, "bad gateway key: {e}"),
        }
    }
}

impl std::error::Error for UriError {}

impl NymUri {
    /// Parse `nym://id.enc@gw` or bare `id.enc@gw`.
    pub fn parse(input: &str) -> Result<Self, UriError> {
        let input = input.trim();
        let rest = input.strip_prefix(SCHEME).unwrap_or(input);
        let (left, gateway_b58) = rest
            .split_once('@')
            .ok_or(UriError::MissingSchemeOrSeparators)?;
        let (identity_b58, encryption_b58) = left
            .split_once('.')
            .ok_or(UriError::MissingSchemeOrSeparators)?;

        Ok(Self {
            identity: decode_key(identity_b58).map_err(UriError::BadIdentity)?,
            encryption: decode_key(encryption_b58).map_err(UriError::BadEncryption)?,
            gateway: decode_key(gateway_b58).map_err(UriError::BadGateway)?,
        })
    }

    /// Canonical encoding without scheme (the wire/display form).
    pub fn encode(&self) -> String {
        format!(
            "{}.{}@{}",
            bs58::encode(self.identity).into_string(),
            bs58::encode(self.encryption).into_string(),
            bs58::encode(self.gateway).into_string()
        )
    }

    /// Canonical URI form with scheme.
    pub fn to_uri(&self) -> String {
        format!("{SCHEME}{}", self.encode())
    }
}

impl FromStr for NymUri {
    type Err = UriError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

impl fmt::Display for NymUri {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_uri())
    }
}

impl fmt::Debug for NymUri {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_uri())
    }
}

fn decode_key(b58: &str) -> Result<[u8; KEY_LEN], String> {
    let bytes = bs58::decode(b58)
        .into_vec()
        .map_err(|e| format!("not base58: {e}"))?;
    if bytes.len() != KEY_LEN {
        return Err(format!(
            "must decode to {KEY_LEN} bytes, got {}",
            bytes.len()
        ));
    }
    let mut out = [0u8; KEY_LEN];
    out.copy_from_slice(&bytes);
    Ok(out)
}
