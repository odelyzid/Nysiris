//! Byte-exact marketplace wire grammar for nysiris-shop
//! (`docs/16-shop.md`, provider: `services/shop`).
//!
//! This crate owns the cross-implementation *format* only: signed envelope
//! framing (`sig`), order-state rules (`status`), hard size limits (`limits`),
//! review aggregation (`review`), and the proof-of-work payload preimages
//! (`pow`). It uses no mixnet code, so browser code can mirror it one field
//! at a time without pulling nym-sdk.
//!
//! The `fly-shop-v1/*` signature domains here are **immutable release
//! contract**: changing them invalidates every existing signed listing,
//! order, message, and review. Do not rename.

pub mod limits;
pub mod pow;
pub mod review;
pub mod sig;
pub mod status;
