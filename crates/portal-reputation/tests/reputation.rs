//! Tests for spam/Sybil primitives (`docs/10-portal.md` §10.5).
use portal_reputation::{
    pow,
    rate::{RateLimiter, RatePolicy},
    reputation::{LocalReputation, Observation, Standing, DECAY_HALF_LIFE_DAYS},
};

#[test]
fn pow_proves_fast_and_verifies_in_one_hash() {
    let author = [3u8; 32];
    let payload_hash = pow::payload_hash(b"hello portal");
    // 8 bits: ~256 hashes on average, instant in tests.
    let proof = pow::prove(&author, &payload_hash, 8, 0, 100_000).expect("8-bit proof");
    assert!(pow::verify(&author, &payload_hash, &proof));
    assert!(pow::leading_zeros(&pow::hash_proof(&author, &payload_hash, proof.nonce)) >= 8);
}

#[test]
fn pow_binds_author_and_payload() {
    let author = [3u8; 32];
    let payload_hash = pow::payload_hash(b"hello portal");
    let proof = pow::prove(&author, &payload_hash, 8, 0, 100_000).unwrap();
    // Another author cannot replay it.
    assert!(!pow::verify(&[4u8; 32], &payload_hash, &proof));
    // Another payload cannot replay it.
    assert!(!pow::verify(&author, &pow::payload_hash(b"other"), &proof));
}

#[test]
fn pow_refuses_absurd_difficulties_and_exhaustion() {
    let author = [3u8; 32];
    let payload_hash = pow::payload_hash(b"x");
    assert!(pow::prove(&author, &payload_hash, 0, 0, 100).is_none());
    assert!(pow::prove(&author, &payload_hash, 99, 0, 100).is_none());
    assert!(pow::prove(&author, &payload_hash, 8, 0, 0).is_none());
    // A provider must never demand more than the ceiling.
    assert!(!pow::verify(
        &author,
        &payload_hash,
        &portal_reputation::pow::Proof { nonce: 0, bits: 99 }
    ));
}

#[test]
fn reputation_scores_observations_and_decays() {
    let mut rep = LocalReputation::new();
    assert_eq!(rep.standing("alice", 100), Standing::Unknown);

    for _ in 0..25 {
        rep.observe("alice", Observation::ValidMessage, 100);
    }
    assert_eq!(rep.standing("alice", 100), Standing::Trusted);

    rep.observe("mallory", Observation::InvalidSignature, 100);
    rep.observe("mallory", Observation::InvalidSignature, 100);
    assert_eq!(rep.standing("mallory", 100), Standing::Blocked);

    rep.observe("bob", Observation::InvalidSignature, 100);
    assert_eq!(rep.standing("bob", 100), Standing::Watch);

    // Scores clamp: volume alone cannot make a key untouchable or irredeemable.
    for _ in 0..200 {
        rep.observe("alice", Observation::ValidMessage, 100);
    }
    assert_eq!(rep.score("alice", 100), 100);
    for _ in 0..200 {
        rep.observe("mallory", Observation::Equivocation, 100);
    }
    assert_eq!(rep.score("mallory", 100), -50);

    // Silence decays toward neutral: one half-life halves the distance.
    assert_eq!(rep.score("alice", 100 + DECAY_HALF_LIFE_DAYS), 50);
    assert_eq!(
        rep.standing("alice", 100 + DECAY_HALF_LIFE_DAYS * 10),
        Standing::Neutral
    );
}

#[test]
fn rate_limiter_caps_bursts_per_author_per_day() {
    let mut limiter = RateLimiter::new(RatePolicy { max_per_day: 3 });
    assert!(limiter.try_spend("alice", 7));
    assert!(limiter.try_spend("alice", 7));
    assert!(limiter.try_spend("alice", 7));
    assert!(!limiter.try_spend("alice", 7), "fourth write refused");
    assert_eq!(limiter.remaining("alice", 7), 0);
    // Other authors and other days are independent budgets.
    assert!(limiter.try_spend("bob", 7));
    assert!(limiter.try_spend("alice", 8));
    // Pruning drops stale bookkeeping.
    limiter.prune(9);
    assert_eq!(limiter.remaining("alice", 7), 3);
}
