//! Tests for the controls asserted in `docs/05-security.md`.
//!
//! Every test names the security section it enforces, so a passing suite is
//! evidence that the documented control is real behaviour rather than prose.

use sphinx_core::enforcement::{
    AttributedNode, ExitRotationPlan, ExitRotationPolicy, PrivacyProfile, ReplyBudget, RoutePolicy,
    RouteViolation, SurbPool, SurbRejection, SurbState, DEFAULT_MAX_SURBS_PER_REQUEST,
    MAX_SURB_AGE_SECS,
};
use sphinx_core::{Destination, DestinationAddress, Node, NodeAddress};
use x25519_dalek::{PublicKey, StaticSecret};

fn hop(id: u8, operator: &str) -> AttributedNode {
    let secret = StaticSecret::from([id; 32]);
    let node = Node::new(NodeAddress::from_bytes([id; 32]), PublicKey::from(&secret));
    AttributedNode::new(node, operator)
}

/// §5.1.4 — a path must not place two hops under one operator.
#[test]
fn route_policy_rejects_repeated_operator() {
    let path = vec![
        hop(1, "entry-op"),
        hop(2, "mix-op"),
        hop(3, "entry-op"), // same operator as the entry gateway
    ];
    let violations = RoutePolicy::default().validate(&path);
    assert!(violations.contains(&RouteViolation::RepeatedOperator("entry-op".into())));
    assert!(RoutePolicy::default().check(&path).is_err());
}

/// §5.1.4 / §5.4.3 — entry and exit under one operator is entry+exit capture.
#[test]
fn route_policy_rejects_entry_exit_collusion() {
    let path = vec![
        hop(1, "same-op"),
        hop(2, "mix-op"),
        hop(3, "same-op"), // first and last share an operator
    ];
    let violations = RoutePolicy::default().validate(&path);
    assert!(violations.contains(&RouteViolation::EntryExitCollusion("same-op".into())));
}

/// A diverse, distinct path passes every rule.
#[test]
fn route_policy_accepts_diverse_path() {
    let path = vec![
        hop(1, "op-a"),
        hop(2, "op-b"),
        hop(3, "op-c"),
        hop(4, "op-d"),
    ];
    RoutePolicy::default()
        .check(&path)
        .expect("diverse path is valid");
}

/// §5.3.2 / §5.3.4 — bounded SURB attachment.
#[test]
fn route_policy_bounds_surb_attachment() {
    let policy = RoutePolicy::default();
    policy
        .validate_attachments(DEFAULT_MAX_SURBS_PER_REQUEST)
        .expect("cap is allowed");
    assert!(policy
        .validate_attachments(DEFAULT_MAX_SURBS_PER_REQUEST + 1)
        .is_err());
}

/// §5.3.1 — a SURB is accepted exactly once.
#[test]
fn surb_pool_enforces_single_use() {
    let mut pool = SurbPool::new(MAX_SURB_AGE_SECS);
    let id = [7u8; 16];
    pool.register(id, 1_000);

    assert_eq!(pool.accept_reply(&id, 1_100), SurbState::Acceptable);
    assert_eq!(
        pool.accept_reply(&id, 1_200),
        SurbState::Rejected(SurbRejection::AlreadyConsumed),
        "a second reply for the same SURB must be refused"
    );
}

/// §5.3.3 — SURBs age out of the rotation window.
#[test]
fn surb_pool_rejects_expired_surbs() {
    let mut pool = SurbPool::new(MAX_SURB_AGE_SECS);
    let id = [9u8; 16];
    pool.register(id, 0);

    let stale = MAX_SURB_AGE_SECS + 1;
    match pool.accept_reply(&id, stale) {
        SurbState::Rejected(SurbRejection::Expired { age_secs }) => {
            assert_eq!(age_secs, stale);
        }
        other => panic!("expected Expired, got {other:?}"),
    }
}

/// Unknown identifiers are refused, and purging drops stale unused SURBs.
#[test]
fn surb_pool_rejects_unknown_and_purges() {
    let mut pool = SurbPool::new(MAX_SURB_AGE_SECS);
    assert_eq!(
        pool.accept_reply(&[1u8; 16], 0),
        SurbState::Rejected(SurbRejection::Unknown)
    );

    pool.register([2u8; 16], 0);
    pool.register([3u8; 16], MAX_SURB_AGE_SECS);
    assert_eq!(pool.purge_expired(MAX_SURB_AGE_SECS + 5), 1);
    assert_eq!(pool.live_count(MAX_SURB_AGE_SECS + 5), 1);
}

/// §5.3.4 — the reply budget cannot be overrun.
#[test]
fn reply_budget_limits_bursts() {
    // Capacity 3, refilling at 50/s (the shared real-packet rate).
    let mut budget = ReplyBudget::new(3, 50.0, 0);
    assert!(budget.try_spend(0));
    assert!(budget.try_spend(0));
    assert!(budget.try_spend(0));
    assert!(!budget.try_spend(0), "bucket exhausted");

    // After 100 ms, ~5 tokens would be available but capacity caps at 3.
    assert_eq!(budget.available(100), 3);
    assert!(budget.try_spend(100));
}

/// §5.2.2 / §5.4.3 — exit rotation to restore request-request unlinkability.
#[test]
fn exit_rotation_policies_behave() {
    let mut per_request = ExitRotationPlan::new(ExitRotationPolicy::PerRequest);
    assert!(per_request.needs_rotation());
    per_request.record_request();
    assert!(per_request.needs_rotation());

    let mut every_two = ExitRotationPlan::new(ExitRotationPolicy::Every { max_requests: 2 });
    assert!(!every_two.needs_rotation());
    every_two.record_request();
    assert!(!every_two.needs_rotation());
    every_two.record_request();
    assert!(every_two.needs_rotation());
    every_two.reset();
    assert!(!every_two.needs_rotation());

    let pinned = ExitRotationPlan::new(ExitRotationPolicy::Pinned);
    assert!(
        !pinned.needs_rotation(),
        "pinned exits accept the P2 trade-off"
    );
}

/// §5.8 — disabling cover traffic / pacing fails closed unless acknowledged.
#[test]
fn privacy_profile_guardrail() {
    let hardened = PrivacyProfile {
        cover_traffic: false,
        poisson_pacing: true,
    };
    assert!(hardened.require_cover_traffic(false).is_err());
    assert!(hardened.require_cover_traffic(true).is_ok());

    let default_profile = PrivacyProfile::default();
    assert!(default_profile.require_cover_traffic(false).is_ok());
}

/// §5.1.4 — a node must not appear twice in one path.
#[test]
fn route_policy_rejects_repeated_node() {
    let a = hop(1, "op-a");
    let b = hop(2, "op-b");
    let path = vec![a.clone(), b, a];
    let violations = RoutePolicy::default().validate(&path);
    assert!(violations
        .iter()
        .any(|v| matches!(v, RouteViolation::RepeatedNode(_))));
}

/// Sanity: the attached-SURB cap and SURB window match the documented values.
#[test]
fn documented_constants_are_stable() {
    assert_eq!(DEFAULT_MAX_SURBS_PER_REQUEST, 8);
    assert_eq!(MAX_SURB_AGE_SECS, 25 * 60 * 60);
    let _ = (Destination::new(
        DestinationAddress::from_bytes([0u8; 32]),
        [0u8; 16],
    ),);
}
