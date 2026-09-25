//! Client-driven gossip sync for portal data.
//!
//! Nobody pushes. A replica keeps per-author heads (`seq` = entries held) and
//! converges by asking: `GET /heads` → compute what is missing → `GET
//! /log/<author>?since=n` → verify + apply. Providers serve; browsers (and
//! other providers) drive. The same wire messages work in TypeScript later.
//!
//! Forks can never enter a replica: [`SyncState::apply_entries`] reuses the
//! continuity rule of [`portal_data::Log`], so an equivocating author simply
//! stops syncing (flagged for the reputation layer).

use std::collections::HashMap;

use portal_data::{Log, LogEntry};
use serde::{Deserialize, Serialize};

mod serve;

pub use serve::{heads_reply_json, log_reply_json};

/// What sequence we hold per author (hex pubkey in wire form).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Heads {
    pub heads: HashMap<String, u64>,
}

impl Heads {
    pub fn get(&self, author_hex: &str) -> u64 {
        self.heads.get(author_hex).copied().unwrap_or(0)
    }

    pub fn set(&mut self, author_hex: String, seq: u64) {
        self.heads.insert(author_hex, seq);
    }
}

/// One fetch unit: entries for `author` starting at `from` (exclusive head).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Want {
    pub author_hex: String,
    pub from_seq: u64,
}

/// Compute what `local` is missing given a peer's advertised heads.
/// One `Want` per author that is ahead of us. Authors we lead are omitted —
/// the peer runs the same computation from its side.
pub fn diff_wants(local: &Heads, peer: &Heads) -> Vec<Want> {
    let mut wants: Vec<Want> = peer
        .heads
        .iter()
        .filter_map(|(author, peer_seq)| {
            let have = local.get(author);
            if *peer_seq > have {
                Some(Want {
                    author_hex: author.clone(),
                    from_seq: have,
                })
            } else {
                None
            }
        })
        .collect();
    wants.sort_by(|a, b| a.author_hex.cmp(&b.author_hex));
    wants
}

/// A replica: per-author verified logs plus our heads.
#[derive(Clone, Debug, Default)]
pub struct Replica {
    logs: HashMap<[u8; 32], Log>,
}

impl Replica {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn heads(&self) -> Heads {
        Heads {
            heads: self
                .logs
                .iter()
                .map(|(author, log)| (hex::encode(author), log.len() as u64))
                .collect(),
        }
    }

    /// Verify and apply entries for one author. Entries must arrive in order
    /// starting exactly at our head; anything else is rejected atomically —
    /// a partial batch never lands.
    pub fn apply_entries(&mut self, entries: Vec<LogEntry>) -> Result<usize, String> {
        if entries.is_empty() {
            return Ok(0);
        }
        let author = entries[0].author;
        if entries.iter().any(|e| e.author != author) {
            return Err("batch mixes authors".into());
        }
        // Stage on a scratch log so rejection leaves us untouched.
        let mut staged = self.logs.get(&author).cloned().unwrap_or_default();
        for entry in &entries {
            staged
                .append(entry.clone())
                .map_err(|e| format!("rejected batch: {e}"))?;
        }
        let n = entries.len();
        self.logs.insert(author, staged);
        Ok(n)
    }

    pub fn log(&self, author: &[u8; 32]) -> Option<&Log> {
        self.logs.get(author)
    }
}
