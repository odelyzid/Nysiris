//! Routing vocabulary: nodes, destinations, delays and format versions.

use crate::constants::*;
use rand::RngCore;
use x25519_dalek::PublicKey;

/// Address of an intermediate hop, sent in the clear inside the header.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeAddress([u8; NODE_ADDRESS_LENGTH]);

impl NodeAddress {
    pub const fn from_bytes(bytes: [u8; NODE_ADDRESS_LENGTH]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; NODE_ADDRESS_LENGTH] {
        &self.0
    }

    pub const fn to_bytes(self) -> [u8; NODE_ADDRESS_LENGTH] {
        self.0
    }
}

impl std::fmt::Debug for NodeAddress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "NodeAddress({})", bs58::encode(self.0).into_string())
    }
}

/// An intermediate mix node: its routing address and its Sphinx (X25519) key.
#[derive(Clone, Copy, Debug)]
pub struct Node {
    pub address: NodeAddress,
    pub pub_key: PublicKey,
}

impl Node {
    pub fn new(address: NodeAddress, pub_key: PublicKey) -> Self {
        Self { address, pub_key }
    }
}

/// The cryptographic identity of a final recipient (service provider or
/// client). This is *not* the human-readable Nym address; the human-readable
/// form is composed in `address.rs`.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct DestinationAddress([u8; DESTINATION_ADDRESS_LENGTH]);

impl DestinationAddress {
    pub const fn from_bytes(bytes: [u8; DESTINATION_ADDRESS_LENGTH]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; DESTINATION_ADDRESS_LENGTH] {
        &self.0
    }

    pub const fn to_bytes(self) -> [u8; DESTINATION_ADDRESS_LENGTH] {
        self.0
    }
}

impl std::fmt::Debug for DestinationAddress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "DestinationAddress({})",
            bs58::encode(self.0).into_string()
        )
    }
}

/// A client-chosen identifier. For SURBs it names the reply block; for forward
/// messages it is an application-level message id.
pub type SurbIdentifier = [u8; IDENTIFIER_LENGTH];

/// The final hop payload of the Sphinx header: where to deliver and under what
/// identifier.
#[derive(Clone, Copy)]
pub struct Destination {
    pub address: DestinationAddress,
    pub identifier: SurbIdentifier,
}

impl Destination {
    pub fn new(address: DestinationAddress, identifier: SurbIdentifier) -> Self {
        Self {
            address,
            identifier,
        }
    }
}

/// Per-hop mixing delay in nanoseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Delay(u64);

impl Delay {
    pub const fn from_nanos(nanos: u64) -> Self {
        Self(nanos)
    }

    pub fn to_bytes(self) -> [u8; DELAY_LENGTH] {
        self.0.to_be_bytes()
    }

    pub fn from_bytes(bytes: [u8; DELAY_LENGTH]) -> Self {
        Self(u64::from_be_bytes(bytes))
    }

    pub fn nanos(self) -> u64 {
        self.0
    }
}

/// Randomised per-hop delays drawn from an exponential distribution with the
/// configured mean. A real client uses the network's advertised per-node
/// delay characteristics; this constant-time version is good enough for tests.
pub fn generate_delays(route_len: usize, average_nanos: u64, rng: &mut impl RngCore) -> Vec<Delay> {
    (0..route_len)
        .map(|_| {
            // Average of a uniform draw is average/2, so scale by 2.
            let span = average_nanos.saturating_mul(2).max(1);
            Delay::from_nanos(rng.next_u64() % span)
        })
        .collect()
}

/// 3-byte `major.minor.patch` format version carried in every routing block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Version([u8; VERSION_LENGTH]);

impl Version {
    /// Reference implementation version. Production must use the exact value
    /// advertised by the live network.
    pub const CURRENT: Version = Version([1, 0, 0]);

    pub const fn new(major: u8, minor: u8, patch: u8) -> Self {
        Self([major, minor, patch])
    }

    pub const fn to_bytes(self) -> [u8; VERSION_LENGTH] {
        self.0
    }

    pub const fn from_bytes(bytes: [u8; VERSION_LENGTH]) -> Self {
        Self(bytes)
    }
}

impl Default for Version {
    fn default() -> Self {
        Self::CURRENT
    }
}
