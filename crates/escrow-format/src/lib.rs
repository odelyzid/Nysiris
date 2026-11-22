//! Byte-exact Monero escrow wire grammar for nysiris-shop
//! (`docs/17-monero-escrow.md`).
//!
//! This crate is *format only*: signed envelopes, hard size limits, and the
//! escrow state machine. It has no wallet, daemon, or mixnet code. All Monero
//! key material stays in external wallets; the shop provider relays these
//! signed messages and opaque blobs but never signs or custodies funds.
//!
//! WARNING: this is a stagenet reference. Monero multisig is still marked
//! experimental upstream and has known operational pitfalls (see doc 17).
//! Nothing here should be used with mainnet funds without an external audit.

pub mod limits;
pub mod message;
pub mod state;
pub mod terms;

pub use message::{
    decode, digest, setup_transcript_hash, sign_message, verify_message, Decoded, Domain, Envelope,
};
pub use state::{EscrowState, Stage};
