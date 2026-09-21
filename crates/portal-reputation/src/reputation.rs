//! Local reputation from first-hand observation.
//!
//! Scores are computed in the browser from things the client itself saw:
//! valid vs forged signatures on receipt, duplicates, undecryptable payloads,
//! rate violations. They are **never fetched from a server** and never
//! published — publishing scores would create exactly the trackable,
//! gameable signal this system avoids.
//!
//! Time is coarse days (`u64`), consistent with the metadata policy. Scores
//! decay toward neutral so a reformed key recovers and a compromised key does
//! not rest on old trust forever.

use std::collections::HashMap;

/// What the client itself observed about an author key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Observation {
    /// A signature verified on receipt.
    ValidMessage,
    /// A signature failed on receipt (forgery or corruption).
    InvalidSignature,
    /// The same object/message seen twice (replay or bug, mildly suspicious).
    Duplicate,
    /// A payload that should decrypt did not.
    Undecryptable,
    /// A log fork or sequence gap attributable to this author.
    Equivocation,
}

impl Observation {
    fn weight(self) -> i32 {
        match self {
            Observation::ValidMessage => 1,
            Observation::Duplicate => -1,
            Observation::Undecryptable => -2,
            Observation::InvalidSignature => -5,
            Observation::Equivocation => -10,
        }
    }
}

/// Standing derived from a score. Thresholds are deliberately coarse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    Unknown,
    Trusted,
    Neutral,
    Watch,
    Blocked,
}

impl Standing {
    pub fn of(score: i32) -> Self {
        if score >= 20 {
            Standing::Trusted
        } else if score >= 0 {
            Standing::Neutral
        } else if score > -10 {
            Standing::Watch
        } else {
            Standing::Blocked
        }
    }
}

/// Scores keyed by author pubkey hex. All state is local.
#[derive(Clone, Debug, Default)]
pub struct LocalReputation {
    scores: HashMap<String, (i32, u64)>,
}

/// Days of inactivity after which a score halves toward zero.
pub const DECAY_HALF_LIFE_DAYS: u64 = 30;

impl LocalReputation {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one first-hand observation at coarse day `today`.
    pub fn observe(&mut self, author_hex: &str, observation: Observation, today: u64) {
        let (score, _) = self.scores.get(author_hex).copied().unwrap_or((0, today));
        let score = score.saturating_add(observation.weight());
        // Clamp: no key becomes untouchable or irredeemable by volume alone.
        let score = score.clamp(-50, 100);
        self.scores.insert(author_hex.to_string(), (score, today));
    }

    /// Score after decay. Each full half-life of silence halves the distance
    /// to zero (integer division, sign-preserving).
    pub fn score(&self, author_hex: &str, today: u64) -> i32 {
        let (score, last_day) = match self.scores.get(author_hex) {
            Some(v) => *v,
            None => return 0,
        };
        let elapsed = today.saturating_sub(last_day);
        let halvings = elapsed / DECAY_HALF_LIFE_DAYS;
        let mut score = score;
        for _ in 0..halvings.min(10) {
            score /= 2;
        }
        score
    }

    pub fn standing(&self, author_hex: &str, today: u64) -> Standing {
        if !self.scores.contains_key(author_hex) {
            return Standing::Unknown;
        }
        Standing::of(self.score(author_hex, today))
    }

    pub fn len(&self) -> usize {
        self.scores.len()
    }

    pub fn is_empty(&self) -> bool {
        self.scores.is_empty()
    }
}
