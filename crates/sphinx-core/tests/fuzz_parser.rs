//! Fuzz / robustness tests for the packet and address parsers.
//!
//! These run on stable Rust in the fast `./build.sh check` loop. They assert the
//! parser contract that the security analysis depends on: **untrusted bytes
//! never panic**, and mutations are rejected by the MAC or safely transformed
//! by the wide-block payload cipher.
//!
//! For coverage-guided fuzzing see `fuzz/` (requires nightly + cargo-fuzz).

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use sphinx_core::{
    constants, Destination, DestinationAddress, Node, NodeAddress, Payload, ProcessedPacket,
    SphinxHeader, SphinxPacket, SphinxPacketBuilder,
};
use x25519_dalek::{PublicKey, StaticSecret};

fn random_node(rng: &mut StdRng) -> (StaticSecret, Node) {
    let mut bytes = [0u8; 32];
    rng.fill(&mut bytes);
    let secret = StaticSecret::from(bytes);
    let public = PublicKey::from(&secret);
    let mut addr = [0u8; 32];
    rng.fill(&mut addr);
    (secret, Node::new(NodeAddress::from_bytes(addr), public))
}

/// Random bytes of random lengths must never panic any parser.
#[test]
fn parsers_never_panic_on_arbitrary_bytes() {
    let mut rng = StdRng::seed_from_u64(0xC0FFEE1234);
    let max = constants::PACKET_SIZE + 512;

    for _ in 0..8_000 {
        let len = rng.gen_range(0..=max);
        let mut buf = vec![0u8; len];
        rng.fill(&mut buf[..]);

        // Must return Ok or Err, never panic or index out of bounds.
        let _ = SphinxPacket::from_bytes(&buf);
        let _ = SphinxHeader::from_bytes(&buf);
        let _ = Payload::from_bytes(&buf);
    }
}

/// All-`0xff` and all-`0x00` inputs exercise the padding/delimiter paths.
#[test]
fn pathological_byte_patterns_are_safe() {
    for byte in [0x00u8, 0xff, 0x01] {
        let buf = vec![byte; constants::PACKET_SIZE];
        let _ = SphinxPacket::from_bytes(&buf);
    }
    // Correct-length packet whose header MAC happens to be checked.
    let mut rng = StdRng::seed_from_u64(7);
    let (sk, node) = random_node(&mut rng);
    let destination = Destination::new(DestinationAddress::from_bytes([0u8; 32]), [0u8; 16]);
    let packet = SphinxPacketBuilder::new()
        .build(&[node], &destination, b"x")
        .unwrap();
    let _ = packet.process(&sk);
}

/// A single-bit mutation of a valid packet must never yield the original
/// plaintext and must never panic. Header mutations fail the MAC; payload
/// mutations randomise the whole wide-block payload.
#[test]
fn single_bit_mutations_are_rejected_or_changed() {
    let mut rng = StdRng::seed_from_u64(0xDEAD_BEEF);
    let message = b"the quick brown fox jumps over the lazy dog";

    for iteration in 0..300 {
        let route_len = rng.gen_range(1..=constants::MAX_PATH_LENGTH);
        let mut secrets = Vec::new();
        let mut route = Vec::new();
        for _ in 0..route_len {
            let (sk, node) = random_node(&mut rng);
            secrets.push(sk);
            route.push(node);
        }
        let destination = Destination::new(DestinationAddress::from_bytes([0xAB; 32]), [0xCD; 16]);
        let packet = SphinxPacketBuilder::new()
            .build(&route, &destination, message)
            .expect("valid packet builds");

        let mut bytes = packet.to_bytes();
        let bit = rng.gen_range(0..bytes.len());
        bytes[bit] ^= 1 << rng.gen_range(0..8);

        let mutated = SphinxPacket::from_bytes(&bytes).expect("same length still parses");
        // Walk the route; either a hop rejects (MAC), or the final plaintext
        // differs from the original. We never panic and never accept the
        // original message from a mutated packet.
        let mut current = mutated;
        for (hop, sk) in secrets.iter().enumerate() {
            match current.process(sk) {
                Err(_) => break,
                Ok(ProcessedPacket::Forward { packet, .. }) => {
                    assert!(hop + 1 < route_len, "forwarded past the final hop");
                    current = packet;
                }
                Ok(ProcessedPacket::Final { payload, .. }) => {
                    if let Ok(plain) = payload.recover_plaintext() {
                        assert_ne!(
                            plain, message,
                            "iteration {iteration}: mutated packet recovered the original plaintext"
                        );
                    }
                    break;
                }
            }
        }
    }
}

/// Truncated and over-long buffers are rejected with the documented error.
#[test]
fn length_validation_is_exact() {
    assert!(SphinxPacket::from_bytes(&[]).is_err());
    assert!(SphinxPacket::from_bytes(&vec![0u8; constants::PACKET_SIZE - 1]).is_err());
    assert!(SphinxPacket::from_bytes(&vec![0u8; constants::PACKET_SIZE + 1]).is_err());
    assert!(SphinxPacket::from_bytes(&vec![0u8; constants::PACKET_SIZE]).is_ok());
    assert!(SphinxHeader::from_bytes(&vec![0u8; constants::HEADER_SIZE - 1]).is_err());
    assert!(SphinxHeader::from_bytes(&vec![0u8; constants::HEADER_SIZE]).is_ok());
}

/// Header serialisation is lossless for arbitrary valid routes.
#[test]
fn header_roundtrip_is_lossless() {
    let mut rng = StdRng::seed_from_u64(0x5EED);
    for _ in 0..100 {
        let route_len = rng.gen_range(1..=constants::MAX_PATH_LENGTH);
        let mut route = Vec::new();
        for _ in 0..route_len {
            let (_, node) = random_node(&mut rng);
            route.push(node);
        }
        let destination = Destination::new(DestinationAddress::from_bytes([3u8; 32]), [4u8; 16]);
        let packet = SphinxPacketBuilder::new()
            .build(&route, &destination, b"roundtrip")
            .unwrap();
        let recovered = SphinxPacket::from_bytes(&packet.to_bytes()).unwrap();
        assert_eq!(recovered.header.to_bytes(), packet.header.to_bytes());
        assert_eq!(recovered.payload.as_bytes(), packet.payload.as_bytes());
    }
}

/// The address parser is total: arbitrary strings never panic.
#[test]
fn address_parser_is_total() {
    let mut rng = StdRng::seed_from_u64(0xADD7);
    for _ in 0..10_000 {
        let len = rng.gen_range(0..64);
        let s: String = (0..len)
            .map(|_| {
                const ALPHABET: &[u8] =
                    b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.@-_%";
                ALPHABET[rng.gen_range(0..ALPHABET.len())] as char
            })
            .collect();
        let _ = sphinx_core::NymAddress::parse(&s);
    }
}
