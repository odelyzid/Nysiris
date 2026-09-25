//! Hidden-service abstraction over Nym mixnet messaging.
//!
//! Nym ships no Tor-style `.onion` stack. This crate provides the equivalent
//! semantics as a thin layer over the messaging shape the SDKs already speak:
//!
//! * [`uri::NymUri`] — canonical `nym://<id>.<enc>@<gw>` addressing.
//! * [`envelope::{Request, Response}`] — HTTP-like request/response envelopes
//!   carried as opaque message bytes, validated by `bridge-guard`.
//! * [`service::{HiddenService, dispatch}`] — server harness: parse, validate,
//!   handle, serialize. Bring your own transport loop (it only needs
//!   `wait_for_messages` / `send_reply` semantics).
//! * [`petnames::PetnameRegistry`] — human names as **local-only** aliases.
//!   There is deliberately no global directory (see `docs/05-security.md`).
//! * [`chunk`] — byte-level split/join for bodies larger than one packet.
//!
//! The crate stays out of the heavy `nym-sdk` toolchain so it runs in the fast
//! `./build.sh check` loop. See `docs/08-hidden-services.md`.

pub mod chunk;
pub mod envelope;
pub mod invite;
pub mod petnames;
pub mod service;
pub mod uri;

pub use bridge_guard::GuardError;
pub use envelope::{Request, Response};
pub use invite::{Invite, InviteError};
pub use service::{dispatch, EchoService, HiddenService};
pub use uri::NymUri;
