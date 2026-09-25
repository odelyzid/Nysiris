//! Shared hidden-service runtime for the nysiris providers.
//!
//! Every service crate (`portal-provider`, `social`, `hybrid-bridge`) runs
//! the same shape of loop: connect a mixnet client, then for each inbound
//! batch answer the senders that attached reply SURBs. This crate owns that
//! loop plus the per-route spam backstops so the behaviour is tested once,
//! nym-free, instead of being copied into each binary.
//!
//! * [`transport`] — [`MixnetRuntime`]: the transport abstraction. Kept
//!   nym-sdk-free: services implement it over `nym_sdk::mixnet::MixnetClient`
//!   (a couple of lines of per-service glue), and tests implement it over a
//!   fake.
//! * [`runner`] — [`run_loop`] + [`hidden_step`]: the request loop and the
//!   hidden-service dispatch seam (keeps
//!   `nym_hidden_service::{HiddenService, dispatch}`).
//! * [`router`] — [`Router`] with its [`PowGuard`] / [`RateGuard`]: optional
//!   proof-of-work + per-author daily budget, composed over
//!   `portal_reputation`.
//!
//! The crate is pure (no nym-sdk, no tokio in the library itself), so it runs
//! in the fast `./build.sh check` loop.

pub mod router;
pub mod runner;
pub mod transport;

pub use router::{today, PowGuard, RateGuard, Router};
pub use runner::{hidden_step, run_loop};
pub use transport::{InboundMessage, MixnetRuntime, Outbound, SendError, SenderTag};
