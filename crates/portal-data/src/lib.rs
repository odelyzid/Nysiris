//! Portal data model: content-addressed signed objects, append-only logs,
//! and a convergent LWW-map.
//!
//! Everything here is pure bytes + signatures: no network, no clock, no I/O.
//! Ingest rules fail closed on malformed or forged input. See
//! `docs/10-portal.md` §10.3 for the design.

pub mod log;
pub mod lww;
pub mod object;

pub use log::{Log, LogEntry};
pub use lww::Dot;
pub use lww::LwwMap;
pub use object::Object;
