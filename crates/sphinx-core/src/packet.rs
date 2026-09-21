//! The Sphinx packet: `(alpha, beta, gamma, delta)` on the wire.

use crate::constants::*;
use crate::error::{SphinxError, SphinxResult};
use crate::header::{ProcessedHeaderData, SphinxHeader};
use crate::payload::Payload;
use crate::route::{
    generate_delays, Delay, Destination, DestinationAddress, Node, NodeAddress, SurbIdentifier,
    Version,
};
use rand::rngs::OsRng;
use rand::RngCore;
use x25519_dalek::StaticSecret;

/// A complete fixed-size Sphinx packet: 348-byte header + 2065-byte payload.
#[derive(Clone)]
pub struct SphinxPacket {
    pub header: SphinxHeader,
    pub payload: Payload,
}

/// The result of a hop processing a packet.
// Packets are fixed-size stack values by design; boxing would only add
// indirection on the hot path.
#[allow(clippy::large_enum_variant)]
pub enum ProcessedPacket {
    /// Forward this packet to `next_hop` after `delay`.
    Forward {
        packet: SphinxPacket,
        next_hop: NodeAddress,
        delay: Delay,
    },
    /// The packet is for us; `payload` has had the final encryption layer
    /// removed and is ready for [`Payload::recover_plaintext`].
    Final {
        destination: DestinationAddress,
        identifier: SurbIdentifier,
        payload: Payload,
    },
}

impl SphinxPacket {
    /// Serialise to exactly [`PACKET_SIZE`] bytes.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(PACKET_SIZE);
        out.extend_from_slice(&self.header.to_bytes());
        out.extend_from_slice(self.payload.as_bytes());
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> SphinxResult<Self> {
        if bytes.len() != PACKET_SIZE {
            return Err(SphinxError::InvalidPacketLength(bytes.len()));
        }
        let header = SphinxHeader::from_bytes(&bytes[..HEADER_SIZE])?;
        let payload = Payload::from_bytes(&bytes[HEADER_SIZE..])?;
        Ok(Self { header, payload })
    }

    /// Process the packet at one hop.
    ///
    /// * verifies the header MAC (`gamma`),
    /// * removes one payload encryption layer (`delta`),
    /// * and either blinds `alpha` for the next hop or reveals the destination.
    pub fn process(&self, node_secret: &StaticSecret) -> SphinxResult<ProcessedPacket> {
        let processed = self.header.process(node_secret)?;
        let payload = self.payload.clone().unwrap_layer(&processed.payload_key)?;

        match processed.data {
            ProcessedHeaderData::Forward {
                updated_header,
                next_hop,
                delay,
            } => Ok(ProcessedPacket::Forward {
                packet: SphinxPacket {
                    header: updated_header,
                    payload,
                },
                next_hop,
                delay,
            }),
            ProcessedHeaderData::Final {
                destination,
                identifier,
            } => Ok(ProcessedPacket::Final {
                destination,
                identifier,
                payload,
            }),
        }
    }
}

/// Fluent builder for outbound packets.
pub struct SphinxPacketBuilder {
    version: Version,
    average_delay_nanos: u64,
}

impl Default for SphinxPacketBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl SphinxPacketBuilder {
    pub fn new() -> Self {
        Self {
            version: Version::CURRENT,
            // 50 ms mean mixing delay per hop; the live network advertises its
            // own per-node delay distribution, which a real client should use.
            average_delay_nanos: 50_000_000,
        }
    }

    pub fn with_version(mut self, version: Version) -> Self {
        self.version = version;
        self
    }

    pub fn with_average_delay_nanos(mut self, nanos: u64) -> Self {
        self.average_delay_nanos = nanos;
        self
    }

    /// Build a packet for `route` (entry gateway, mix nodes, destination
    /// gateway) delivering `message` to `destination`.
    pub fn build(
        &self,
        route: &[Node],
        destination: &Destination,
        message: &[u8],
    ) -> SphinxResult<SphinxPacket> {
        let mut rng = OsRng;
        let delays = generate_delays(route.len(), self.average_delay_nanos, &mut rng);
        let (header, expanded) =
            SphinxHeader::build(route, &delays, destination, self.version, &mut rng)?;
        let payload_keys: Vec<[u8; PAYLOAD_KEY_SIZE]> =
            expanded.iter().map(|e| e.payload_key()).collect();
        let payload = Payload::build(message, &payload_keys)?;
        Ok(SphinxPacket { header, payload })
    }
}

/// Generate random bytes with the OS CSPRNG (helper for callers that need a
/// fresh identity).
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    OsRng.fill_bytes(&mut out);
    out
}
