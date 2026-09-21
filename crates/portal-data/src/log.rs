//! Append-only per-author logs: portable, replayable identity history.
//!
//! ```text
//! entry_bytes = b"fly-portal-v1/log-entry" || author(32) || seq_be64 || obj_id(32)
//! ```
//!
//! Ingest rule: `seq` must equal the current log length. Forks (two entries
//! with the same seq) are rejected, never merged — a fork is evidence of
//! equivocation and belongs to the reputation layer, not the log.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};

pub const LOG_ENTRY_DOMAIN: &[u8] = b"fly-portal-v1/log-entry";

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LogEntry {
    pub author: [u8; 32],
    pub seq: u64,
    pub obj_id: [u8; 32],
    pub sig: [u8; 64],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogError {
    BadAuthor(String),
    BadSignature(String),
    BadSequence { expected: u64, got: u64 },
}

impl std::fmt::Display for LogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LogError::BadAuthor(e) => write!(f, "bad author key: {e}"),
            LogError::BadSignature(e) => write!(f, "bad entry signature: {e}"),
            LogError::BadSequence { expected, got } => {
                write!(f, "expected seq {expected}, got {got} (fork or gap)")
            }
        }
    }
}

impl std::error::Error for LogError {}

pub fn entry_bytes(author: &[u8; 32], seq: u64, obj_id: &[u8; 32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(LOG_ENTRY_DOMAIN.len() + 32 + 8 + 32);
    out.extend_from_slice(LOG_ENTRY_DOMAIN);
    out.extend_from_slice(author);
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(obj_id);
    out
}

/// An author's log. Single-writer by construction (only the author holds the key).
#[derive(Clone, Debug, Default)]
pub struct Log {
    pub author: Option<[u8; 32]>,
    entries: Vec<LogEntry>,
}

impl Log {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entries(&self) -> &[LogEntry] {
        &self.entries
    }

    pub fn head(&self) -> Option<&LogEntry> {
        self.entries.last()
    }

    /// Verify and append one entry. The first entry fixes the log's author;
    /// every entry after must continue the sequence with the same author.
    pub fn append(&mut self, entry: LogEntry) -> Result<(), LogError> {
        if let Some(author) = self.author {
            if author != entry.author {
                return Err(LogError::BadAuthor(
                    "entry author differs from log author".into(),
                ));
            }
        }
        let expected = self.entries.len() as u64;
        if entry.seq != expected {
            return Err(LogError::BadSequence {
                expected,
                got: entry.seq,
            });
        }
        let key = VerifyingKey::from_bytes(&entry.author)
            .map_err(|e| LogError::BadAuthor(e.to_string()))?;
        if key.is_weak() {
            return Err(LogError::BadAuthor("weak (small-order) key".into()));
        }
        key.verify(
            &entry_bytes(&entry.author, entry.seq, &entry.obj_id),
            &Signature::from_bytes(&entry.sig),
        )
        .map_err(|e| LogError::BadSignature(e.to_string()))?;
        self.author = Some(entry.author);
        self.entries.push(entry);
        Ok(())
    }
}
