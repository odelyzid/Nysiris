//! Provider-side serving: the two read routes that make replication work,
//! as pure functions so their exact JSON is a tested contract instead of
//! body code in each provider binary.
//!
//! Both return `serde_json::Value` built with `json!` — deliberately, not
//! typed structs: with default features serde_json maps are BTree-ordered,
//! so object keys come out alphabetically, and the golden vectors in
//! `tests/golden.rs` pin the exact bytes the browser TypeScript port must
//! reproduce. Typed structs would serialize in declaration order and change
//! the wire.

use portal_data::Log;
use serde_json::Value;

/// `GET /heads` reply: `{"heads":[{"author":hex,"seq":n}, ...]}`.
///
/// `pairs` is the `(author key, entries-held)` list a store yields — the
/// same one replicas exchange to compute want-lists (one `Want` per author
/// the peer is ahead of).
pub fn heads_reply_json(pairs: &[([u8; 32], u64)]) -> Value {
    let items: Vec<Value> = pairs
        .iter()
        .map(|(author, seq)| serde_json::json!({ "author": hex::encode(author), "seq": seq }))
        .collect();
    serde_json::json!({ "heads": items })
}

/// `GET /log/<author>?since=n` reply: `{"entries":[...],"head":m}` with every
/// entry at `seq >= since`, hex fields. `head` is the total entries held
/// (one past the last seq, so a client's `from_seq` gap is `head - have`).
pub fn log_reply_json(log: &Log, since: u64) -> Value {
    let entries: Vec<Value> = log
        .entries()
        .iter()
        .filter(|e| e.seq >= since)
        .map(|e| {
            serde_json::json!({
                "author": hex::encode(e.author),
                "seq": e.seq,
                "obj_id": hex::encode(e.obj_id),
                "sig": hex::encode(e.sig),
            })
        })
        .collect();
    serde_json::json!({ "entries": entries, "head": log.len() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;
    use portal_data::log::entry_bytes;

    fn log_of(seed: u8, count: u64) -> Log {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
        let author = sk.verifying_key().to_bytes();
        let mut log = Log::new();
        for seq in 0..count {
            let obj_id = [seed; 32];
            let sig = sk.sign(&entry_bytes(&author, seq, &obj_id)).to_bytes();
            log.append(portal_data::LogEntry {
                author,
                seq,
                obj_id,
                sig,
            })
            .unwrap();
        }
        log
    }

    #[test]
    fn log_reply_serves_only_entries_at_or_after_since() {
        let log = log_of(5, 3);
        let reply = log_reply_json(&log, 1);
        let entries = reply["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["seq"], 1);
        assert_eq!(entries[1]["seq"], 2);
        assert_eq!(reply["head"], 3);
    }

    #[test]
    fn log_reply_of_an_empty_log_has_zero_entries() {
        let reply = log_reply_json(&Log::new(), 0);
        assert_eq!(reply["entries"].as_array().unwrap().len(), 0);
        assert_eq!(reply["head"], 0);
    }

    #[test]
    fn heads_reply_maps_pairs_to_hex_author_list() {
        let pairs = [([1u8; 32], 3), ([2u8; 32], 0)];
        let reply = heads_reply_json(&pairs);
        let items = reply["heads"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["author"], hex::encode([1u8; 32]));
        assert_eq!(items[0]["seq"], 3);
    }
}
