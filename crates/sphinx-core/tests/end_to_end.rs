//! End-to-end tests: build a packet, route it through every hop, and recover
//! the plaintext. This is the test that proves the header geometry, the
//! blinding chain, the filler, and the payload onion all agree.

use sphinx_core::*;
use x25519_dalek::{PublicKey, StaticSecret};

fn node(id: u8) -> (StaticSecret, Node) {
    let secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
    let public = PublicKey::from(&secret);
    (secret, Node::new(NodeAddress::from_bytes([id; 32]), public))
}

#[test]
fn packet_routes_through_three_hops_and_recovers_plaintext() {
    let (sk0, n0) = node(1);
    let (sk1, n1) = node(2);
    let (sk2, n2) = node(3);

    let route = vec![n0, n1, n2];
    let destination_address = DestinationAddress::from_bytes([9u8; 32]);
    let destination = Destination::new(destination_address, [7u8; 16]);
    let message = b"hello, mixnet";

    let packet = SphinxPacketBuilder::new()
        .build(&route, &destination, message)
        .expect("packet builds");

    // Every packet is exactly the same size on the wire.
    assert_eq!(packet.to_bytes().len(), sphinx_core::REGULAR_PACKET_SIZE);
    assert_eq!(sphinx_core::REGULAR_PACKET_SIZE, 2413);

    // Round-trip through bytes, like a real node would after receiving it.
    let packet = SphinxPacket::from_bytes(&packet.to_bytes()).expect("deserialises");

    // Hop 0.
    let at_hop1 = match packet.process(&sk0).expect("hop 0 accepts") {
        ProcessedPacket::Forward {
            packet,
            next_hop,
            delay: _,
        } => {
            assert_eq!(next_hop, n1.address);
            packet
        }
        ProcessedPacket::Final { .. } => panic!("hop 0 must not be final"),
    };

    // Hop 1.
    let at_hop2 = match at_hop1.process(&sk1).expect("hop 1 accepts") {
        ProcessedPacket::Forward {
            packet, next_hop, ..
        } => {
            assert_eq!(next_hop, n2.address);
            packet
        }
        ProcessedPacket::Final { .. } => panic!("hop 1 must not be final"),
    };

    // Hop 2 is the destination.
    match at_hop2.process(&sk2).expect("final hop accepts") {
        ProcessedPacket::Final {
            destination: recovered_destination,
            identifier,
            payload,
        } => {
            assert_eq!(recovered_destination, destination_address);
            assert_eq!(identifier, [7u8; 16]);
            assert_eq!(payload.recover_plaintext().unwrap(), message);
        }
        ProcessedPacket::Forward { .. } => panic!("hop 2 must be final"),
    }
}

#[test]
fn tampered_header_is_rejected_by_the_mac() {
    let (sk0, n0) = node(1);
    let (_sk1, n1) = node(2);
    let destination = Destination::new(DestinationAddress::from_bytes([4u8; 32]), [0u8; 16]);

    let packet = SphinxPacketBuilder::new()
        .build(&[n0, n1], &destination, b"secret")
        .expect("packet builds");

    let mut bytes = packet.to_bytes();
    // Byte 100 lives inside the encrypted routing information (`beta`).
    bytes[100] ^= 0x01;

    let tampered = SphinxPacket::from_bytes(&bytes).expect("still parses");
    match tampered.process(&sk0) {
        Err(SphinxError::InvalidHeaderMac) => {}
        Err(other) => panic!("expected InvalidHeaderMac, got {other:?}"),
        Ok(_) => panic!("expected InvalidHeaderMac, but the tampered packet was accepted"),
    }
}

#[test]
fn surb_reply_travels_back_to_creator() {
    let (sk0, n0) = node(10);
    let (sk1, n1) = node(11);
    let (creator_sk, creator_node) = node(12);

    // The creator is the final hop of its own return route.
    let route = vec![n0, n1, creator_node];
    let mut rng = rand::rngs::OsRng;
    let delays = generate_delays(route.len(), 1_000_000, &mut rng);

    let creator_destination =
        Destination::new(DestinationAddress::from_bytes([0xAB; 32]), [0xCD; 16]);
    let material =
        create_surb(&route, &delays, &creator_destination, &mut rng).expect("surb builds");

    // The responder only needs the SURB material.
    let reply = material.reply(b"anonymous pong").expect("reply builds");
    assert_eq!(reply.to_bytes().len(), REGULAR_PACKET_SIZE);

    let at_hop1 = match reply.process(&sk0).unwrap() {
        ProcessedPacket::Forward { packet, .. } => packet,
        ProcessedPacket::Final { .. } => panic!(),
    };
    let at_creator = match at_hop1.process(&sk1).unwrap() {
        ProcessedPacket::Forward { packet, .. } => packet,
        ProcessedPacket::Final { .. } => panic!(),
    };
    match at_creator.process(&creator_sk).unwrap() {
        ProcessedPacket::Final { payload, .. } => {
            assert_eq!(payload.recover_plaintext().unwrap(), b"anonymous pong");
        }
        ProcessedPacket::Forward { .. } => panic!("creator must be the final hop"),
    }
}

#[test]
fn oversized_message_is_rejected() {
    let (_sk, n) = node(1);
    let destination = Destination::new(DestinationAddress::from_bytes([0u8; 32]), [0u8; 16]);
    let too_big = vec![0u8; 4096];
    assert!(SphinxPacketBuilder::new()
        .build(&[n], &destination, &too_big)
        .is_err());
}
