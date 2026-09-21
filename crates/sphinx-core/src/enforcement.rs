//! Enforced, testable controls derived from the security analysis
//! (`docs/05-security.md`).
//!
//! The reference core is where route/packet/SURB policy can be asserted
//! mechanically, so the rules the docs describe are real code with real tests,
//! not prose. Everything here is deliberately conservative: a control that
//! cannot be enforced fails closed.
//!
//! | Control | Security section | Function |
//! |---|---|---|
//! | Distinct operators per path | §5.1.4 | [`RoutePolicy::validate`] |
//! | No entry+exit on one operator | §5.1.4 / §5.4.3 | [`RoutePolicy::validate`] |
//! | Single-use SURBs | §5.3.1 | [`SurbPool`] |
//! | SURB expiry (~25 h) | §5.3.3 | [`SurbPool`] |
//! | Bounded SURB attachment | §5.3.2 / §5.3.4 | [`RoutePolicy::validate_attachments`] |
//! | Bounded reply rate | §5.3.4 | [`ReplyBudget`] |
//! | Exit rotation (P2) | §5.2.2 / §5.4.3 | [`ExitRotationPlan`] |
//! | Cover-traffic guardrail | §5.8 | [`PrivacyProfile::require_cover_traffic`] |

use std::collections::{HashMap, HashSet};

use crate::constants::IDENTIFIER_LENGTH;
use crate::error::{SphinxError, SphinxResult};
use crate::route::{Node, NodeAddress};
use crate::surb::SurbMaterial;

/// Nine hours of unix time: the upper bound on SURB validity, per §5.3.3
/// (Nym rotates node keys roughly every hour and caps reply-key age at
/// ~24 epochs, ≈25 hours total).
pub const MAX_SURB_AGE_SECS: u64 = 25 * 60 * 60;

/// Default cap on how many SURBs a client will attach to a single request.
/// Keeps a request from becoming a reply-amplification vector (§5.3.4) and
/// keeps the message within the ~55 packet/s budget (§5.8).
pub const DEFAULT_MAX_SURBS_PER_REQUEST: usize = 8;

// ---------------------------------------------------------------------------
// Route policy
// ---------------------------------------------------------------------------

/// Identity of the party operating a node. Two nodes with the same operator
/// are not independent, so a path must not rely on both.
///
/// In production this is derived from the topology (operator/ASN attribution);
/// here it is an explicit field so policy is testable.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct OperatorId(pub String);

impl From<&str> for OperatorId {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl From<String> for OperatorId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

/// One routable hop together with its operator attribution.
#[derive(Clone, Debug)]
pub struct AttributedNode {
    pub node: Node,
    pub operator: OperatorId,
}

impl AttributedNode {
    pub fn new(node: Node, operator: impl Into<String>) -> Self {
        Self {
            node,
            operator: OperatorId(operator.into()),
        }
    }
}

/// Route-validation policy. Every rule maps to a documented control.
///
/// `Default` is secure: `false` means repeats and entry/exit collusion are
/// rejected.
#[derive(Clone, Debug, Default)]
pub struct RoutePolicy {
    /// Allow the same operator to appear more than once in a path.
    pub allow_repeated_operator: bool,
    /// Allow the first and last hop to share an operator (entry+exit capture).
    pub allow_entry_exit_collusion: bool,
}

/// Why a path was rejected. Each variant cites the security section it enforces.
#[derive(Debug, PartialEq, Eq)]
pub enum RouteViolation {
    /// §5.1.4 — a path must not use one operator twice.
    RepeatedOperator(OperatorId),
    /// §5.1.4 / §5.4.3 — an adversary controlling entry and exit sees both ends.
    EntryExitCollusion(OperatorId),
    /// §5.1.4 — no hop may be reused.
    RepeatedNode(NodeAddress),
}

impl std::fmt::Display for RouteViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RouteViolation::RepeatedOperator(op) => {
                write!(f, "operator `{}` appears more than once in the path", op.0)
            }
            RouteViolation::EntryExitCollusion(op) => write!(
                f,
                "entry and exit share operator `{}` (entry+exit capture)",
                op.0
            ),
            RouteViolation::RepeatedNode(addr) => {
                write!(f, "node {addr:?} appears more than once in the path")
            }
        }
    }
}

impl RoutePolicy {
    /// Relax repeated-operator checks (use only when the topology cannot
    /// attribute operators). Entry/exit collusion stays checked.
    pub fn allow_repeated_operator(mut self) -> Self {
        self.allow_repeated_operator = true;
        self
    }

    /// Validate an attributed path, returning every violation found.
    pub fn validate(&self, path: &[AttributedNode]) -> Vec<RouteViolation> {
        let mut violations = Vec::new();

        if !self.allow_repeated_operator {
            let mut seen: HashMap<&OperatorId, usize> = HashMap::new();
            for hop in path {
                *seen.entry(&hop.operator).or_insert(0) += 1;
            }
            for (operator, count) in seen {
                if count > 1 {
                    violations.push(RouteViolation::RepeatedOperator(operator.clone()));
                }
            }
        }

        if !self.allow_entry_exit_collusion {
            if let (Some(first), Some(last)) = (path.first(), path.last()) {
                if first.operator == last.operator {
                    violations.push(RouteViolation::EntryExitCollusion(first.operator.clone()));
                }
            }
        }

        let mut addresses = HashSet::new();
        for hop in path {
            if !addresses.insert(hop.node.address) {
                violations.push(RouteViolation::RepeatedNode(hop.node.address));
            }
        }

        violations
    }

    /// Convenience: `Ok(())` iff the path satisfies every rule.
    pub fn check(&self, path: &[AttributedNode]) -> SphinxResult<()> {
        let violations = self.validate(path);
        if violations.is_empty() {
            Ok(())
        } else {
            Err(SphinxError::InvalidAddress(format!(
                "route policy rejected the path: {}",
                violations
                    .iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>()
                    .join("; ")
            )))
        }
    }

    /// §5.3.2/§5.3.4 — bound how many SURBs a client attaches to one request.
    pub fn validate_attachments(&self, surb_count: usize) -> SphinxResult<()> {
        if surb_count > DEFAULT_MAX_SURBS_PER_REQUEST {
            return Err(SphinxError::InvalidAddress(format!(
                "too many SURBs attached ({surb_count} > {DEFAULT_MAX_SURBS_PER_REQUEST}); \
                 attach the minimum needed for the expected reply"
            )));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// SURB pool: single-use + expiry
// ---------------------------------------------------------------------------

/// A pool that enforces the two SURB invariants a client owns:
/// **single use** (§5.3.1) and **expiry** (§5.3.3).
///
/// The pool hands out an identifier when a SURB is created and refuses to
/// observe a reply for that identifier twice, or after the SURB has aged out.
pub struct SurbPool {
    issued_at: HashMap<[u8; IDENTIFIER_LENGTH], u64>,
    consumed: HashSet<[u8; IDENTIFIER_LENGTH]>,
    max_age_secs: u64,
}

/// Outcome of polling a SURB identifier.
#[derive(Debug, PartialEq, Eq)]
pub enum SurbState {
    /// Never issued, already consumed, or expired: do not accept the reply.
    Rejected(SurbRejection),
    /// Fresh and unused; the reply may be accepted once.
    Acceptable,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SurbRejection {
    /// §5.3.1 — the same SURB was observed twice.
    AlreadyConsumed,
    /// §5.3.3 — the SURB is older than the rotation window.
    Expired { age_secs: u64 },
    /// The identifier was never issued by this pool.
    Unknown,
}

impl SurbPool {
    pub fn new(max_age_secs: u64) -> Self {
        Self {
            issued_at: HashMap::new(),
            consumed: HashSet::new(),
            max_age_secs,
        }
    }

    /// Register a freshly created SURB under `identifier`, bound to `now`.
    pub fn register(&mut self, identifier: [u8; IDENTIFIER_LENGTH], now: u64) {
        self.issued_at.insert(identifier, now);
        self.consumed.remove(&identifier);
    }

    /// Register a SURB produced by [`crate::surb::create_surb`], returning its id.
    pub fn register_material(
        &mut self,
        material: &SurbMaterial,
        now: u64,
    ) -> [u8; IDENTIFIER_LENGTH] {
        self.register(material.identifier, now);
        material.identifier
    }

    /// Evaluate an inbound reply identifier at time `now`. **Consumes** it on
    /// success, so a second call with the same id is rejected.
    pub fn accept_reply(&mut self, identifier: &[u8; IDENTIFIER_LENGTH], now: u64) -> SurbState {
        if self.consumed.contains(identifier) {
            return SurbState::Rejected(SurbRejection::AlreadyConsumed);
        }
        let Some(&issued) = self.issued_at.get(identifier) else {
            return SurbState::Rejected(SurbRejection::Unknown);
        };
        let age = now.saturating_sub(issued);
        if age > self.max_age_secs {
            self.consumed.insert(*identifier);
            return SurbState::Rejected(SurbRejection::Expired { age_secs: age });
        }
        self.consumed.insert(*identifier);
        SurbState::Acceptable
    }

    /// Drop issued-but-unused SURBs that are older than the window.
    pub fn purge_expired(&mut self, now: u64) -> usize {
        let expired: Vec<_> = self
            .issued_at
            .iter()
            .filter(|(id, issued)| {
                now.saturating_sub(**issued) > self.max_age_secs && !self.consumed.contains(*id)
            })
            .map(|(id, _)| *id)
            .collect();
        for id in &expired {
            self.issued_at.remove(id);
        }
        expired.len()
    }

    /// Live (issued, unused, unexpired) SURB count at `now`.
    pub fn live_count(&self, now: u64) -> usize {
        self.issued_at
            .iter()
            .filter(|(id, issued)| {
                !self.consumed.contains(*id) && now.saturating_sub(**issued) <= self.max_age_secs
            })
            .count()
    }

    pub fn consumed_count(&self) -> usize {
        self.consumed.len()
    }
}

// ---------------------------------------------------------------------------
// Reply budget: §5.3.4
// ---------------------------------------------------------------------------

/// A token-bucket reply budget, modelling the shared ~50 packets/s stream a
/// service provider must not exceed (§5.3.4, §5.8).
pub struct ReplyBudget {
    capacity: u32,
    tokens: f64,
    refill_per_sec: f64,
    last_refill_ms: u64,
}

impl ReplyBudget {
    pub fn new(capacity: u32, refill_per_sec: f64, now_ms: u64) -> Self {
        Self {
            capacity,
            tokens: capacity as f64,
            refill_per_sec,
            last_refill_ms: now_ms,
        }
    }

    fn refill(&mut self, now_ms: u64) {
        let elapsed = now_ms.saturating_sub(self.last_refill_ms) as f64 / 1000.0;
        self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity as f64);
        self.last_refill_ms = now_ms;
    }

    /// Try to spend one reply packet. Returns false when the budget is exhausted
    /// (the provider must drop or defer rather than overrun its stream).
    pub fn try_spend(&mut self, now_ms: u64) -> bool {
        self.refill(now_ms);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    pub fn available(&mut self, now_ms: u64) -> u32 {
        self.refill(now_ms);
        self.tokens.floor() as u32
    }
}

// ---------------------------------------------------------------------------
// Exit rotation: §5.2.2 / §5.4.3
// ---------------------------------------------------------------------------

/// Decides whether a fresh exit gateway is required for the next request.
///
/// A fixed exit is a linking key at the destination (P2 fails), so the default
/// policy rotates per request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitRotationPolicy {
    /// New exit for every request. Restores P2; costs availability.
    PerRequest,
    /// Reuse an exit until `max_requests` have gone through it.
    Every { max_requests: u32 },
    /// Pin an exit. Explicitly accepts the P2 trade-off.
    Pinned,
}

#[derive(Debug)]
pub struct ExitRotationPlan {
    policy: ExitRotationPolicy,
    requests_on_current: u32,
}

impl ExitRotationPlan {
    pub fn new(policy: ExitRotationPolicy) -> Self {
        Self {
            policy,
            requests_on_current: 0,
        }
    }

    /// Returns true when a new exit must be selected *before* the next request.
    pub fn needs_rotation(&self) -> bool {
        match self.policy {
            ExitRotationPolicy::PerRequest => true,
            ExitRotationPolicy::Every { max_requests } => self.requests_on_current >= max_requests,
            ExitRotationPolicy::Pinned => false,
        }
    }

    /// Record that a request went out on the current exit.
    pub fn record_request(&mut self) {
        self.requests_on_current += 1;
    }

    /// Called after a new exit has been chosen.
    pub fn reset(&mut self) {
        self.requests_on_current = 0;
    }

    pub fn requests_on_current(&self) -> u32 {
        self.requests_on_current
    }
}

// ---------------------------------------------------------------------------
// Privacy profile: §5.8
// ---------------------------------------------------------------------------

/// The privacy-affecting switches a browser client exposes. The guardrail makes
/// the §5.8 trade-off explicit: disabling cover traffic or Poisson pacing is a
/// **downgrade against the network observer**, and must be acknowledged.
#[derive(Clone, Copy, Debug)]
pub struct PrivacyProfile {
    pub cover_traffic: bool,
    pub poisson_pacing: bool,
}

impl Default for PrivacyProfile {
    fn default() -> Self {
        Self {
            cover_traffic: true,
            poisson_pacing: true,
        }
    }
}

impl PrivacyProfile {
    /// Fails closed unless the caller has explicitly acknowledged the downgrade
    /// that `docs/05-security.md` §5.8 warns about.
    pub fn require_cover_traffic(&self, acknowledged: bool) -> SphinxResult<()> {
        if (self.cover_traffic && self.poisson_pacing) || acknowledged {
            return Ok(());
        }
        Err(SphinxError::InvalidAddress(
            "cover traffic / Poisson pacing disabled without acknowledgement: \
             this weakens you against a network observer (L3G); pass an explicit \
             acknowledgement to proceed"
                .into(),
        ))
    }
}
