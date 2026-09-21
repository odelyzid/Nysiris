#![no_main]
//! Coverage-guided fuzz target: every parser must be total.
//!
//! Run with:
//!   cargo install cargo-fuzz
//!   cd crates/sphinx-core && cargo +nightly fuzz run parse_packet
use libfuzzer_sys::fuzz_target;
use sphinx_core::{NymAddress, Payload, SphinxHeader, SphinxPacket};

fuzz_target!(|data: &[u8]| {
    let _ = SphinxPacket::from_bytes(data);
    let _ = SphinxHeader::from_bytes(data);
    let _ = Payload::from_bytes(data);
    if let Ok(text) = std::str::from_utf8(data) {
        let _ = NymAddress::parse(text);
    }
});
