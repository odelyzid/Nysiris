//! Heavy soak test for routes and messages.
//!
//! Ignored by default so `./build.sh check` stays fast. Run it explicitly:
//!
//! ```bash
//! ./build.sh soak                       # ~5000 iterations, release mode
//! SPHINX_SOAK_ITERS=50000 ./build.sh soak
//! ```
//!
//! Invariants checked on every iteration:
//! * a packet is always exactly `PACKET_SIZE` bytes,
//! * each hop in the chosen route accepts the packet in order,
//! * the final hop recovers exactly the message that was sent,
//! * no panic, regardless of route length or message length.

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use sphinx_core::{
    constants, Destination, DestinationAddress, Node, NodeAddress, ProcessedPacket, SphinxPacket,
    SphinxPacketBuilder, REGULAR_PACKET_SIZE,
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

#[test]
#[ignore = "heavy; run with ./build.sh soak"]
fn soak_routes_and_messages() {
    let iterations: u64 = std::env::var("SPHINX_SOAK_ITERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5_000);
    let seed: u64 = std::env::var("SPHINX_SOAK_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0x50AC_50AC);

    let mut rng = StdRng::seed_from_u64(seed);
    let max_plaintext = constants::DEFAULT_PAYLOAD_SIZE - constants::PAYLOAD_OVERHEAD_SIZE;

    let started = std::time::Instant::now();
    let mut bytes_processed: u64 = 0;

    for iteration in 0..iterations {
        let route_len = rng.gen_range(1..=constants::MAX_PATH_LENGTH);
        let mut secrets = Vec::with_capacity(route_len);
        let mut route = Vec::with_capacity(route_len);
        for _ in 0..route_len {
            let (sk, node) = random_node(&mut rng);
            secrets.push(sk);
            route.push(node);
        }

        let msg_len = rng.gen_range(0..=max_plaintext);
        let mut message = vec![0u8; msg_len];
        rng.fill(&mut message[..]);

        let destination = Destination::new(DestinationAddress::from_bytes([0x11; 32]), [0x22; 16]);
        let packet = SphinxPacketBuilder::new()
            .build(&route, &destination, &message)
            .unwrap_or_else(|e| panic!("iteration {iteration}: build failed: {e}"));

        // Invariant: fixed size on the wire.
        let wire = packet.to_bytes();
        assert_eq!(wire.len(), REGULAR_PACKET_SIZE, "iteration {iteration}");
        assert_eq!(wire.len(), 2413);
        bytes_processed += wire.len() as u64;

        // Invariant: the packet parses back losslessly.
        let mut current = SphinxPacket::from_bytes(&wire)
            .unwrap_or_else(|e| panic!("iteration {iteration}: parse failed: {e}"));

        // Invariant: every hop accepts in order and the last recovers the message.
        for (hop, sk) in secrets.iter().enumerate() {
            match current.process(sk) {
                Err(e) => panic!("iteration {iteration}: hop {hop} rejected a valid packet: {e}"),
                Ok(ProcessedPacket::Forward { packet, .. }) => {
                    assert!(
                        hop + 1 < route_len,
                        "iteration {iteration}: forwarded past final hop"
                    );
                    current = packet;
                }
                Ok(ProcessedPacket::Final { payload, .. }) => {
                    assert_eq!(hop + 1, route_len, "iteration {iteration}: final too early");
                    let recovered = payload
                        .recover_plaintext()
                        .unwrap_or_else(|e| panic!("iteration {iteration}: recover failed: {e}"));
                    assert_eq!(recovered, message, "iteration {iteration}: wrong plaintext");
                    break;
                }
            }
        }
    }

    let elapsed = started.elapsed();
    let per_packet_us = elapsed.as_micros() as f64 / iterations.max(1) as f64;
    println!(
        "soak ok: {iterations} iterations, {bytes_processed} bytes, {elapsed:?} ({per_packet_us:.1} µs/iteration, seed {seed})"
    );
}
