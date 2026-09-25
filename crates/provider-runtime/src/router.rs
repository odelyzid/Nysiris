//! Provider-side spam backstops, composed for every route that writes.
//!
//! Two gates, in the same order every provider applied them inline:
//!
//! 1. [`PowGuard`] — optional client-side proof-of-work. Providers advertise
//!    their difficulty in the descriptor; `bits == 0` disables the gate.
//!    Hard ceiling is `pow::MAX_POW_BITS` (32), so a malicious provider can
//!    never demand years of CPU.
//! 2. [`RateGuard`] — per-author daily budget (fail-closed on exhaustion),
//!    the backstop when the price is wrong or paid.
//!
//! [`Router`] carries both so providers pass one piece of shared state
//! instead of `(pow_bits, Mutex<RateLimiter>)`. Err strings are the exact
//! body text previous versions returned (400 / 429).

use std::sync::Mutex;

use portal_reputation::pow::{self, Proof};
use portal_reputation::rate::{RateLimiter, RatePolicy};

/// Coarse UTC day number, shared by the rate gate.
pub fn today() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0)
}

/// Optional proof-of-work gate. Disabled (bits 0) → every check passes, so
/// providers can flip open lightly without touching their route code.
pub struct PowGuard {
    bits: u32,
}

impl PowGuard {
    pub fn new(bits: u32) -> Self {
        Self {
            bits: bits.min(pow::MAX_POW_BITS),
        }
    }

    /// Difficulty advertised to clients. `0` means "no proof required".
    pub fn bits(&self) -> u32 {
        self.bits
    }

    pub fn is_enabled(&self) -> bool {
        self.bits != 0
    }

    /// Verify a raw proof (cheap, one hash). Always passes when disabled.
    pub fn verify(&self, author: &[u8; 32], payload_hash: &[u8; 32], proof: &Proof) -> bool {
        if !self.is_enabled() {
            return true;
        }
        pow::verify(author, payload_hash, proof)
    }

    /// Extract and verify the `{"nonce": u64, "bits": u32}` proof from a JSON
    /// request body. `Err(reason)` is the canned body text for a 400.
    pub fn verify_json(
        &self,
        author: &[u8; 32],
        payload_hash: &[u8; 32],
        body: &serde_json::Value,
    ) -> Result<(), &'static str> {
        if !self.is_enabled() {
            return Ok(());
        }
        let pow_field = body.get("pow").ok_or("proof-of-work required")?;
        let nonce = pow_field
            .get("nonce")
            .and_then(serde_json::Value::as_u64)
            .ok_or("bad pow nonce")?;
        let bits = pow_field
            .get("bits")
            .and_then(serde_json::Value::as_u64)
            .map(|b| b as u32)
            .ok_or("bad pow bits")?;
        if bits < self.bits {
            return Err("proof-of-work below required difficulty");
        }
        if !pow::verify(author, payload_hash, &Proof { nonce, bits }) {
            return Err("invalid proof-of-work");
        }
        Ok(())
    }
}

/// Per-author (or per-route-bucket) daily budget. Fail-closed on
/// exhaustion: over budget → reject, never queue.
pub struct RateGuard {
    limiter: Mutex<RateLimiter>,
}

impl RateGuard {
    pub fn new(policy: RatePolicy) -> Self {
        Self {
            limiter: Mutex::new(RateLimiter::new(policy)),
        }
    }

    /// Spend one write for `bucket` on today's budget. `Err` is the 429 body.
    pub fn check(&self, bucket: &str) -> Result<(), &'static str> {
        let mut limiter = self
            .limiter
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if limiter.try_spend(bucket, today()) {
            Ok(())
        } else {
            Err("rate budget exhausted for today")
        }
    }

    /// Writes left for `bucket` today (for diagnostics / descriptor reports).
    pub fn remaining(&self, bucket: &str) -> u32 {
        let limiter = self
            .limiter
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        limiter.remaining(bucket, today())
    }
}

/// The composed spam backstop for a provider's write paths.
pub struct Router {
    pub pow: PowGuard,
    pub rate: RateGuard,
}

impl Router {
    pub fn new(pow_bits: u32, policy: RatePolicy) -> Self {
        Self {
            pow: PowGuard::new(pow_bits),
            rate: RateGuard::new(policy),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AUTHOR: [u8; 32] = [7; 32];

    fn hash(data: &[u8]) -> [u8; 32] {
        pow::payload_hash(data)
    }

    fn valid_json(nonce: u64, bits: u32) -> serde_json::Value {
        serde_json::json!({ "pow": { "nonce": nonce, "bits": bits } })
    }

    #[test]
    fn gate_clamps_difficulty_to_the_hard_ceiling() {
        let gate = PowGuard::new(2_000_000);
        assert_eq!(gate.bits(), pow::MAX_POW_BITS);
        assert!(gate.is_enabled());
    }

    #[test]
    fn disabled_gate_accepts_anything() {
        let gate = PowGuard::new(0);
        assert!(!gate.is_enabled());
        assert!(gate.verify(&AUTHOR, &hash(b"x"), &Proof { nonce: 0, bits: 0 }));
        assert!(gate
            .verify_json(&AUTHOR, &hash(b"x"), &serde_json::json!({}))
            .is_ok());
    }

    #[test]
    fn verify_json_accepts_a_proven_nonce() {
        let gate = PowGuard::new(4);
        let payload_hash = hash(b"payload");
        let proof = pow::prove(&AUTHOR, &payload_hash, 4, 0, 100_000).expect("4 bits proves fast");
        assert_eq!(
            gate.verify_json(&AUTHOR, &payload_hash, &valid_json(proof.nonce, proof.bits)),
            Ok(())
        );
        assert!(gate.verify(&AUTHOR, &payload_hash, &proof));
    }

    #[test]
    fn verify_json_rejects_missing_malformed_and_under_proofed() {
        let gate = PowGuard::new(8);
        let payload_hash = hash(b"payload");

        assert_eq!(
            gate.verify_json(&AUTHOR, &payload_hash, &serde_json::json!({})),
            Err("proof-of-work required")
        );
        assert_eq!(
            gate.verify_json(&AUTHOR, &payload_hash, &serde_json::json!({ "pow": {} })),
            Err("bad pow nonce")
        );
        assert_eq!(
            gate.verify_json(&AUTHOR, &payload_hash, &valid_json(0, 8)),
            Err("invalid proof-of-work")
        );
        assert_eq!(
            gate.verify_json(
                &AUTHOR,
                &payload_hash,
                &serde_json::json!({ "pow": { "nonce": 1, "bits": 4 } })
            ),
            Err("proof-of-work below required difficulty")
        );
    }

    #[test]
    fn rate_budget_fails_closed_and_counts_remaining() {
        let guard = RateGuard::new(RatePolicy { max_per_day: 2 });
        assert_eq!(guard.remaining("alice"), 2);
        assert!(guard.check("alice").is_ok());
        assert!(guard.check("alice").is_ok());
        assert_eq!(guard.check("alice"), Err("rate budget exhausted for today"));
        assert_eq!(guard.remaining("alice"), 0);
        // Other buckets are untouched.
        assert!(guard.check("bob").is_ok());
    }
}
