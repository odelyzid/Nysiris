//! Single-Use Reply Blocks (SURBs).
//!
//! A SURB is a pre-computed Sphinx header plus the full vector of per-hop
//! payload keys for the return route. Handing the SURB to a correspondent lets
//! them construct a valid reply packet **without learning the return path**.
//!
//! Following Nym's `sphinx-packet::surb`, the material stays on the responder
//! side and the reply payload is layered with *all* hop keys, so every mix on
//! the way peels exactly one layer, just like a forward packet.
//!
//! ```text
//! Creator (client)                         Responder (service)
//!   create_surb(route, dest) ──SURB──────▶ stores header + payload_keys
//!                                          reply(msg) ──▶ SphinxPacket
//!   ◀──────── mixnet return path ────────────┘
//! ```

use crate::constants::{PACKET_SIZE, PAYLOAD_KEY_SIZE};
use crate::error::SphinxResult;
use crate::header::SphinxHeader;
use crate::packet::SphinxPacket;
use crate::payload::Payload;
use crate::route::{Delay, Destination, Node, NodeAddress, Version};
use rand::RngCore;

/// Everything a responder needs to send one anonymous reply.
pub struct SurbMaterial {
    /// Pre-computed Sphinx header for the return route.
    pub header: SphinxHeader,
    /// Address of the first hop the reply must be sent to.
    pub first_hop: NodeAddress,
    /// Per-hop Lioness keys, outermost first.
    pub payload_keys: Vec<[u8; PAYLOAD_KEY_SIZE]>,
    /// Identifier under which the creator will recognise the reply.
    pub identifier: [u8; crate::constants::IDENTIFIER_LENGTH],
}

impl SurbMaterial {
    /// Wrap `message` in a reply packet. Single-use: call once, then discard.
    pub fn reply(&self, message: &[u8]) -> SphinxResult<SphinxPacket> {
        let payload = Payload::build(message, &self.payload_keys)?;
        Ok(SphinxPacket {
            header: self.header.clone(),
            payload,
        })
    }
}

/// Create a SURB for `route` ending at `destination`.
///
/// `route` must include the creator's own final hop (its gateway, or in this
/// reference implementation the creator's node identity) as its last element.
pub fn create_surb(
    route: &[Node],
    delays: &[Delay],
    destination: &Destination,
    rng: &mut impl RngCore,
) -> SphinxResult<SurbMaterial> {
    let first_hop = route
        .first()
        .ok_or(crate::error::SphinxError::EmptyRoute)?
        .address;

    let (header, expanded) =
        SphinxHeader::build(route, delays, destination, Version::CURRENT, rng)?;

    let payload_keys: Vec<[u8; PAYLOAD_KEY_SIZE]> =
        expanded.iter().map(|e| e.payload_key()).collect();

    Ok(SurbMaterial {
        header,
        first_hop,
        payload_keys,
        identifier: destination.identifier,
    })
}

/// Serialised size of a SURB with `hops` hops (header + first hop + key seeds).
pub fn serialised_surb_size(hops: usize) -> usize {
    crate::constants::HEADER_SIZE + crate::constants::NODE_ADDRESS_LENGTH + hops * PAYLOAD_KEY_SIZE
}

/// A reply packet is the same fixed size as any other packet.
pub const SURB_REPLY_PACKET_SIZE: usize = PACKET_SIZE;
