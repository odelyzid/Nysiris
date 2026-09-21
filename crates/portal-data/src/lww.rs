//! LWW-map: convergent shared mutable state without coordination.
//!
//! Each key holds the value with the greatest dot, where a dot is
//! `(day, author, obj_hash)` compared lexicographically. Merge is union + max,
//! hence commutative, associative, and idempotent: any two replicas that
//! exchange entries converge to the same map.
//!
//! Wall-clock dependence is limited to coarse days, consistent with the
//! metadata policy. Ties beyond the day break toward the greater author key,
//! then the greater object hash — deterministic, no randomness, no negotiation.

use std::collections::HashMap;

/// A growth point: when (and by whom, for what) a value was written.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Dot {
    pub day: u64,
    pub author: [u8; 32],
    pub obj_hash: [u8; 32],
}

/// Last-writer-wins map over string keys and byte values.
#[derive(Clone, Debug, Default)]
pub struct LwwMap {
    entries: HashMap<String, (Dot, Vec<u8>)>,
}

impl LwwMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert wins only if `dot` beats the stored dot for `key`.
    /// Returns true when the value changed.
    pub fn insert(&mut self, key: String, dot: Dot, value: Vec<u8>) -> bool {
        match self.entries.get(&key) {
            Some((existing, _)) if *existing >= dot => false,
            _ => {
                self.entries.insert(key, (dot, value));
                true
            }
        }
    }

    pub fn get(&self, key: &str) -> Option<&[u8]> {
        self.entries.get(key).map(|(_, v)| v.as_slice())
    }

    pub fn get_dot(&self, key: &str) -> Option<Dot> {
        self.entries.get(key).map(|(d, _)| *d)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Merge another replica's entries into this one.
    pub fn merge(&mut self, other: &LwwMap) {
        for (key, (dot, value)) in &other.entries {
            self.insert(key.clone(), *dot, value.clone());
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Dot, &[u8])> {
        self.entries.iter().map(|(k, (d, v))| (k, d, v.as_slice()))
    }
}
