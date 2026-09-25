//! Byte-exact social wire grammar for nysiris-social
//! (`docs/09-social.md`, provider: `services/social`).
//!
//! This crate owns the cross-implementation *format* only: signed envelope
//! framing (`sig`), attachment metadata + canonical binding bytes (`attach`),
//! hard size limits (`limits`), and the proof-of-work payload preimages
//! (`pow`). It uses no mixnet code, so `node --test`-compatible browser code
//! can mirror it one field at a time without pulling nym-sdk.
//!
//! The `fly-social-v1/*` signature domains here are **immutable release
//! contract**: changing them invalidates every existing signed post, profile,
//! invite, and DM. Do not rename.

pub mod attach;
pub mod limits;
pub mod pow;
pub mod sig;
