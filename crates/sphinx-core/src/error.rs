//! Error type for the reference Sphinx core.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SphinxError {
    #[error("route must contain at least one hop")]
    EmptyRoute,

    #[error("route length {0} exceeds MAX_PATH_LENGTH ({max})", max = crate::constants::MAX_PATH_LENGTH)]
    RouteTooLong(usize),

    #[error("number of delays does not match number of hops")]
    DelayCountMismatch,

    #[error("header integrity MAC verification failed (packet was tampered with)")]
    InvalidHeaderMac,

    #[error("unknown routing flag: {0}")]
    UnknownRoutingFlag(u8),

    #[error("invalid header length: {0} bytes")]
    InvalidHeaderLength(usize),

    #[error("invalid packet length: {0} bytes")]
    InvalidPacketLength(usize),

    #[error("message is too large: {0} bytes")]
    MessageTooLarge(usize),

    #[error("malformed payload: {0}")]
    MalformedPayload(&'static str),

    #[error("payload decryption failed")]
    PayloadDecryptionFailed,

    #[error("invalid Nym address: {0}")]
    InvalidAddress(String),
}

pub type SphinxResult<T> = Result<T, SphinxError>;
