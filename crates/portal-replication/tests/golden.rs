//! Golden wire vectors: byte-exact snapshots of the replication JSON so the
//! browser TypeScript port must reproduce the exact same bytes, and any
//! drift (field rename, key reorder, hex case, key order) fails loudly here.
//!
//! serde_json maps are BTree-ordered (default features), so object keys are
//! alphabetical (`author` < `obj_id` < `seq` < `sig`). These strings are the
//! canonical wire, not an approximation; signatures are deterministic under
//! ed25519-dalek, so the vectors are reproducible forever.
//!
//! One stability note baked in: `heads_reply_json` and `log_reply_json`
//! preserve caller order (Vec), but `Heads` (a `HashMap`) must be golden
//! with a single author — multi-entry map iteration order is not portable.

use ed25519_dalek::{Signer, SigningKey};
use portal_data::{log::entry_bytes, Log, LogEntry};
use portal_replication::{heads_reply_json, log_reply_json, Heads, Want};

const ALICE: &str = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
const BOB: &str = "1398f62c6d1a457c51ba6a4b5f3dbd2f69fca93216218dc8997e416bd17d93ca";

fn deterministic_author(seed: u8) -> ([u8; 32], SigningKey) {
    let sk = SigningKey::from_bytes(&[seed; 32]);
    (sk.verifying_key().to_bytes(), sk)
}

fn deterministic_log(seed: u8, count: u64) -> Log {
    let (author, sk) = deterministic_author(seed);
    let mut log = Log::new();
    for seq in 0..count {
        let obj_id = [seed; 32];
        let sig = sk.sign(&entry_bytes(&author, seq, &obj_id)).to_bytes();
        log.append(LogEntry {
            author,
            seq,
            obj_id,
            sig,
        })
        .unwrap();
    }
    log
}

fn hex32(seed: u8) -> String {
    hex::encode([seed; 32])
}

fn bytes(value: &serde_json::Value) -> String {
    serde_json::to_vec(value)
        .map(String::from_utf8)
        .unwrap()
        .unwrap()
}

#[test]
fn heads_reply_wire_is_stable() {
    let (alice, _) = deterministic_author(7);
    let (bob, _) = deterministic_author(8);
    // Caller order is preserved: alice first, bob second.
    let got = bytes(&heads_reply_json(&[(alice, 3), (bob, 1)]));
    let want =
        format!(r#"{{"heads":[{{"author":"{ALICE}","seq":3}},{{"author":"{BOB}","seq":1}}]}}"#);
    assert_eq!(got, want);
}

#[test]
fn log_reply_wire_is_stable() {
    let got = bytes(&log_reply_json(&deterministic_log(7, 2), 0));
    // Two obj writes at seed 07, so obj_id is the same; only seq and sig vary.
    let want = format!(
        r#"{{"entries":[{{"author":"{ALICE}","obj_id":"{OBJ}","seq":0,"sig":"{SIG0}"}},{{"author":"{ALICE}","obj_id":"{OBJ}","seq":1,"sig":"{SIG1}"}}],"head":2}}"#,
        OBJ = hex32(7),
        SIG0 = "ffc87d3e2874b24edee845705c4982d1a9ac983e4b63efeedfadf7050189541a80ecce309ad055301255c965d78bf2f82dbf3672c944d4d3e3722a7f0f88d307",
        SIG1 = "58263ef4759523de28395fa6636622d82e8f622aa5244b56827fdd525bbfd93f0b48cc33c7ede0d1459b3c1b0e5fc7501bf164445a3f1ef39dc74938187a0606",
    );
    assert_eq!(got, want);
}

#[test]
fn heads_map_wire_is_stable() {
    let mut heads = Heads::default();
    heads.set(BOB.to_string(), 1);
    let got = bytes(&serde_json::to_value(&heads).unwrap());
    let want = format!(r#"{{"heads":{{"{BOB}":1}}}}"#);
    assert_eq!(got, want);
}

#[test]
fn want_wire_is_stable() {
    let got = bytes(
        &serde_json::to_value(&Want {
            author_hex: ALICE.to_string(),
            from_seq: 3,
        })
        .unwrap(),
    );
    let want = format!(r#"{{"author_hex":"{ALICE}","from_seq":3}}"#);
    assert_eq!(got, want);
}

#[test]
fn wire_is_hex_lowercase() {
    // No uppercase hex may ever sneak in — the TS hex encoder must match case.
    assert!(!bytes(&heads_reply_json(&[([0xAB; 32], 1)])).contains('A'));
}
