//! Path selection over a mixnet topology snapshot.
//!
//! The client fetches an epoch-scoped topology from the nym-api, verifies it,
//! and then chooses one node from each layer uniformly at random. No node ever
//! sees the full path, so the only entity that knows all hops is the client.

use crate::route::Node;
use rand::seq::SliceRandom;
use rand::Rng;

/// Which kind of destination a path terminates at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DestinationKind {
    /// A pure-mixnet service provider reachable only by Nym address.
    ServiceProvider,
    /// A clearnet destination reached through an Exit Gateway's Network
    /// Requester (SOCKS) or IP Packet Router.
    Clearnet,
}

/// Number of mix layers in the production Nym mixnet.
pub const MIX_LAYERS: usize = 3;

/// A routable path plus metadata the UI needs.
pub struct SelectedPath {
    /// Entry gateway, three mix nodes, then the destination gateway.
    pub route: Vec<Node>,
    /// True when the final hop is an Exit Gateway (clearnet traffic).
    pub uses_exit_gateway: bool,
    /// Total number of Sphinx hops.
    pub hops: usize,
}

/// Epoch-scoped view of the network. All lists are the nodes *eligible this
/// epoch*; a production client filters by version, liveness, and stake.
pub struct MixnetTopology {
    pub entry_gateways: Vec<Node>,
    pub mix_layers: [Vec<Node>; MIX_LAYERS],
    pub exit_gateways: Vec<Node>,
}

impl MixnetTopology {
    /// Choose one entry gateway, one node per mix layer, and (for clearnet) an
    /// exit gateway. Returns `None` if any required layer is empty.
    pub fn select_path(
        &self,
        kind: DestinationKind,
        destination_gateway: Node,
        rng: &mut impl Rng,
    ) -> Option<SelectedPath> {
        let entry = *self.entry_gateways.choose(rng)?;
        let mut route = vec![entry];
        for layer in &self.mix_layers {
            route.push(*layer.choose(rng)?);
        }

        let (last, uses_exit_gateway) = match kind {
            // Pure mixnet: the final hop is the service's own gateway.
            DestinationKind::ServiceProvider => (destination_gateway, false),
            // Clearnet: the final hop is an exit gateway.
            DestinationKind::Clearnet => (*self.exit_gateways.choose(rng)?, true),
        };
        route.push(last);

        Some(SelectedPath {
            hops: route.len(),
            route,
            uses_exit_gateway,
        })
    }
}
