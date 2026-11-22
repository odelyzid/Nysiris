//! Hard wire limits for the stagenet escrow reference (doc 17).
//! Mirrored in `web/src/domain/escrow.ts` and checked by
//! `scripts/check-constants.mjs`.

/// Reference cap: 10 XMR in piconeros. Not a mainnet limit.
pub const MAX_ESCROW_ATOMIC: u64 = 10_000_000_000_000;

/// One `MultisigxV2…` setup round blob (hex or binary as supplied by the RPC).
pub const MAX_BLOB_BYTES: usize = 16_384;

/// Maximum accepted signed envelope on the wire. The largest legal payload is
/// well under this; the extra room keeps the relay's decode work bounded.
pub const MAX_ENVELOPE_BYTES: usize = 32_768;

/// `get_tx_proof` output for one funding transaction.
pub const MAX_PROOF_BYTES: usize = 8_192;

/// Monero primary/subaddress string, also used for payout addresses.
pub const MAX_ADDRESS_BYTES: usize = 128;

/// Dispute reason body (UTF-8, NUL-free).
pub const MAX_BODY_BYTES: usize = 256;

/// Per-actor monotonic sequence bound.
pub const MAX_SEQ: u64 = 9_223_372_036_854_775_807;

/// Coarse-day freshness window, same as the shop protocol.
pub const DAY_SKEW: u64 = 2;

/// An unfunded escrow session is abandoned after this many coarse days.
pub const FUNDING_DAYS: u64 = 3;

/// Monero's smallest unit: 1 XMR = 1e12 piconeros.
pub const XMR_ATOMIC_UNITS: u64 = 1_000_000_000_000;
