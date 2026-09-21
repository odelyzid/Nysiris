//! Provider-side per-author rate limits: the backstop.
//!
//! PoW prices spam; when the price is wrong (or the attacker pays it), the
//! provider still needs a ceiling. Budgets are per author key per coarse day,
//! in-memory, fail-open on clock weirdness but fail-closed on exhaustion:
//! over budget → reject the write, never queue it.
//!
//! In-memory state resets on restart. That is acceptable for a backstop
//! (budgets are about bursts, not accounting), and it keeps this module pure.
//! Persist to SQLite if per-day accounting across restarts ever matters.

use std::collections::HashMap;

/// Policy: at most `max_per_day` writes per author per coarse day.
#[derive(Clone, Copy, Debug)]
pub struct RatePolicy {
    pub max_per_day: u32,
}

impl Default for RatePolicy {
    fn default() -> Self {
        Self { max_per_day: 500 }
    }
}

#[derive(Clone, Debug, Default)]
pub struct RateLimiter {
    policy: RatePolicy,
    /// (author_hex, day) -> used count.
    used: HashMap<(String, u64), u32>,
}

impl RateLimiter {
    pub fn new(policy: RatePolicy) -> Self {
        Self {
            policy,
            used: HashMap::new(),
        }
    }

    /// Spend one write for `author_hex` on `today`. Returns false when the
    /// budget is exhausted — the caller must reject the write.
    pub fn try_spend(&mut self, author_hex: &str, today: u64) -> bool {
        let key = (author_hex.to_string(), today);
        let used = self.used.get(&key).copied().unwrap_or(0);
        if used >= self.policy.max_per_day {
            return false;
        }
        self.used.insert(key, used + 1);
        true
    }

    pub fn remaining(&self, author_hex: &str, today: u64) -> u32 {
        let used = self
            .used
            .get(&(author_hex.to_string(), today))
            .copied()
            .unwrap_or(0);
        self.policy.max_per_day.saturating_sub(used)
    }

    /// Drop bookkeeping for days before `today` (call occasionally).
    pub fn prune(&mut self, today: u64) {
        self.used
            .retain(|(_, day), _| *day >= today.saturating_sub(1));
    }
}
