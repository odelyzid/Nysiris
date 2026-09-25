//! Hosting SDK for Nysiris hidden services.
//!
//! `nym-hidden-service` defines *what* a hidden service is (addresses,
//! envelopes, the [`HiddenService`] trait, petnames, chunking) and
//! `provider-runtime` defines *how* to serve it (the transport-generic
//! request loop). This crate is the ergonomic layer an operator actually
//! depends on:
//!
//! * [`HostConfig`] — storage dir, optional gateway pin, and the
//!   `nym-address.txt` convention, resolved from flags or env.
//! * [`serve`] — run a [`HiddenService`] over any [`MixnetRuntime`].
//! * [`StaticFiles`] — a traversal-safe file service (`nysiris host files`).
//! * a curated re-export of both lower-level crates, so a service author has
//!   one dependency to add. See `docs/13-sdk-cli.md`.
//!
//! The crate is deliberately **nym-free**: the trait it serves over is
//! implemented against `nym-sdk` in the standalone `nysiris-cli` binary, so
//! this stays in the fast `./build.sh check` loop.
//!
//! ```no_run
//! use nysiris_sdk::{serve, EchoService, HostConfig, MixnetRuntime};
//!
//! async fn run(runtime: &mut impl MixnetRuntime) {
//!     let _config = HostConfig::from_env();
//!     serve(runtime, &EchoService).await;
//! }
//! ```

pub mod files;
pub mod host;

pub use files::StaticFiles;
pub use host::{serve, HostConfig};

/// Curated re-export of the hidden-service abstraction.
pub use nym_hidden_service::envelope::DEFAULT_MAX_BODY_BYTES;
pub use nym_hidden_service::petnames::PetnameRegistry;
pub use nym_hidden_service::uri::UriError;
pub use nym_hidden_service::{
    chunk, dispatch, EchoService, GuardError, HiddenService, Invite, InviteError, NymUri, Request,
    Response,
};

/// Curated re-export of the shared provider runtime.
pub use provider_runtime::route;
pub use provider_runtime::{
    hidden_step, run_loop, today, InboundMessage, MixnetRuntime, Outbound, PowGuard, RateGuard,
    Router, SendError, SenderTag,
};

/// Everything a hidden-service author commonly needs, in one import.
pub mod prelude {
    pub use crate::{
        dispatch, serve, EchoService, HiddenService, HostConfig, MixnetRuntime, NymUri,
        PetnameRegistry, Request, Response,
    };
}
