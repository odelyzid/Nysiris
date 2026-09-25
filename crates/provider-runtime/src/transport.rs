//! Transport abstraction: everything the provider run loop needs from the
//! mixnet, kept nym-sdk-free so the loop is unit-testable against a fake.
//!
//! Nym's `AnonymousSenderTag` is exactly `[u8; 16]` (public
//! `to_bytes`/`from_bytes`), so `SenderTag` round-trips losslessly through
//! the real adapter in each service.

use std::fmt;

/// SURB reply tag: the 16-byte anonymous sender tag Nym stamps on inbound
/// repliable messages. `None` on an inbound message means the sender attached
/// no reply SURBs — nothing can be sent back.
pub type SenderTag = [u8; 16];

/// One inbound mixnet message, with the tag needed to answer it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundMessage {
    pub message: Vec<u8>,
    pub sender_tag: Option<SenderTag>,
}

/// A reply to send back to an inbound message's sender.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outbound {
    pub sender_tag: SenderTag,
    pub reply: Vec<u8>,
}

/// Failure to hand a reply to the transport (transport closed, backlogged…).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendError(pub String);

impl fmt::Display for SendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SendError {}

/// Mixnet transport for one provider. Implemented by the service crates over
/// `nym_sdk::mixnet::MixnetClient`, and by the fake in the runner tests.
///
/// `wait_for_messages` returning `None` means the transport has closed, which
/// [`run_loop`](crate::runner::run_loop) treats as "stop serving". `disconnect`
/// is the graceful teardown hook invoked when the loop exits.
///
/// Native async fn keeps this dependency-free (`async_trait` would pull a dep
/// for three methods). The trait is shared only by nysiris's own binaries and
/// test fakes, so `async_fn_in_trait` auto-trait-bounds are irrelevant.
#[allow(async_fn_in_trait)]
pub trait MixnetRuntime {
    /// Block until the next batch of inbound messages, or `None` on close.
    async fn wait_for_messages(&mut self) -> Option<Vec<InboundMessage>>;

    /// Send `reply` to the sender identified by `sender_tag` (via its SURBs).
    async fn send_reply(&self, sender_tag: SenderTag, reply: Vec<u8>) -> Result<(), SendError>;

    /// Graceful teardown (disconnect the underlying client). Called by
    /// `run_loop` on exit.
    async fn disconnect(&mut self) {}
}
