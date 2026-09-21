//! # sphinx-core — reference implementation of Nym's Sphinx packet format
//!
//! > **Not for production use.** This crate exists to make the format
//! > auditable and to reproduce Nym's wire geometry for tests and tooling.
//! > Production clients and services must depend on Nym's own crates
//! > (`nym-sphinx`, `sphinx-packet`, `nym-sdk`) and, in the browser, on
//! > `@nymproject/mix-tunnel` / `mixFetch`. Rolling your own mixnet crypto in
//! > an application is how people get de-anonymised.
//!
//! The implementation mirrors `sphinx-packet` v0.6.x:
//!
//! * `alpha` = ephemeral Curve25519 point, blinded per hop,
//! * `beta`  = AES-128-CTR-encrypted routing information + Sphinx filler,
//! * `gamma` = HMAC-SHA256(beta) truncated to 16 bytes,
//! * `delta` = Lioness (BLAKE2b + ChaCha) onion-encrypted payload,
//! * shared secrets via X25519 + HKDF-SHA256 expanded to 288 bytes.
//!
//! See `docs/01-architecture.md` and `docs/02-addressing-and-routing.md`.

pub mod address;
pub mod constants;
pub mod crypto;
pub mod enforcement;
pub mod error;
pub mod header;
pub mod packet;
pub mod path;
pub mod payload;
pub mod route;
pub mod surb;

pub use address::NymAddress;
pub use enforcement::{
    AttributedNode, ExitRotationPlan, ExitRotationPolicy, OperatorId, PrivacyProfile, ReplyBudget,
    RoutePolicy, RouteViolation, SurbPool, SurbRejection, SurbState, DEFAULT_MAX_SURBS_PER_REQUEST,
    MAX_SURB_AGE_SECS,
};
pub use error::{SphinxError, SphinxResult};
pub use header::{ProcessedHeader, ProcessedHeaderData, SphinxHeader};
pub use packet::{ProcessedPacket, SphinxPacket, SphinxPacketBuilder};
pub use path::{DestinationKind, MixnetTopology, SelectedPath};
pub use payload::Payload;
pub use route::{
    generate_delays, Delay, Destination, DestinationAddress, Node, NodeAddress, SurbIdentifier,
    Version,
};
pub use surb::{create_surb, SurbMaterial};

/// On-the-wire size of a regular Sphinx packet (2413 bytes).
pub const REGULAR_PACKET_SIZE: usize = constants::PACKET_SIZE;
