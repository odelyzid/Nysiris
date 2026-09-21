//! Tests for the portal data model (`docs/10-portal.md` §10.3).
use ed25519_dalek::Signer;
use portal_data::{Dot, Log, LogEntry, LwwMap, Object};

fn keypair(seed: u8) -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[seed; 32])
}

#[test]
fn object_id_is_stable_and_binds_everything() {
    let sk = keypair(1);
    let a = Object::sign_new(&sk, "post", b"hello".to_vec()).unwrap();
    let b = Object::sign_new(&sk, "post", b"hello".to_vec()).unwrap();
    assert_eq!(a.id, b.id, "deterministic signing must give stable ids");

    // JSON round-trip preserves the verified object, including its id.
    let back = Object::from_json(&a.to_json()).unwrap();
    assert_eq!(back, a);
}

#[test]
fn object_rejects_tampering_forgery_and_garbage() {
    let sk = keypair(2);
    let author = sk.verifying_key().to_bytes();
    let obj = Object::sign_new(&sk, "post", b"hello".to_vec()).unwrap();

    // Tampered payload fails signature verification.
    assert!(Object::parse_untrusted(&obj.kind, &obj.author, b"hello!", &obj.sig).is_err());
    // Wrong author fails.
    assert!(Object::parse_untrusted(&obj.kind, &[9u8; 32], &obj.payload, &obj.sig).is_err());
    // Wrong kind fails.
    assert!(Object::parse_untrusted("profile", &obj.author, &obj.payload, &obj.sig).is_err());
    // Bad kinds are rejected before any crypto.
    assert!(Object::parse_untrusted("", &author, b"x", &[0u8; 64]).is_err());
    assert!(Object::parse_untrusted("UPPER", &author, b"x", &[0u8; 64]).is_err());
    assert!(Object::parse_untrusted("a b", &author, b"x", &[0u8; 64]).is_err());
    // Oversized payloads are rejected.
    assert!(Object::parse_untrusted("post", &author, &vec![0u8; 17 * 1024], &[0u8; 64]).is_err());
    // Forged id in the JSON envelope is caught.
    let mut json = obj.to_json();
    json["id"] = serde_json::json!("00".repeat(32));
    assert!(Object::from_json(&json).is_err());
    // Unknown kinds verify fine (storable) — rendering is the caller's decision.
    let custom = Object::sign_new(&sk, "wiki/page", b"data".to_vec()).unwrap();
    assert!(Object::from_json(&custom.to_json()).is_ok());
}

#[test]
fn log_enforces_continuity_and_rejects_forks() {
    let sk = keypair(3);
    let author = sk.verifying_key().to_bytes();
    let mut log = Log::new();

    let entry = |seq: u64, obj_id: [u8; 32]| LogEntry {
        author,
        seq,
        obj_id,
        sig: sk
            .sign(&portal_data::log::entry_bytes(&author, seq, &obj_id))
            .to_bytes(),
    };

    log.append(entry(0, [1u8; 32])).unwrap();
    log.append(entry(1, [2u8; 32])).unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(log.head().unwrap().obj_id, [2u8; 32]);

    // Gap rejected.
    assert!(log.append(entry(3, [3u8; 32])).is_err());
    // Fork (reused seq) rejected.
    assert!(log.append(entry(1, [9u8; 32])).is_err());
    // Other author's entry rejected.
    let other = keypair(4);
    let other_author = other.verifying_key().to_bytes();
    let forged = LogEntry {
        author: other_author,
        seq: 2,
        obj_id: [5u8; 32],
        sig: other
            .sign(&portal_data::log::entry_bytes(&other_author, 2, &[5u8; 32]))
            .to_bytes(),
    };
    assert!(log.append(forged).is_err());
    assert_eq!(log.len(), 2, "rejected appends must not mutate the log");
}

#[test]
fn lww_merge_is_commutative_idempotent_and_convergent() {
    let alice = [1u8; 32];
    let bob = [2u8; 32];
    let dot = |day: u64, author: [u8; 32]| Dot {
        day,
        author,
        obj_hash: [7u8; 32],
    };

    let mut a = LwwMap::new();
    let mut b = LwwMap::new();
    a.insert("name".into(), dot(10, alice), b"Alice".to_vec());
    b.insert("name".into(), dot(11, bob), b"Bob".to_vec());
    b.insert("bio".into(), dot(11, bob), b"hi".to_vec());

    // Commutative: merge order does not matter.
    let mut ab = a.clone();
    ab.merge(&b);
    let mut ba = b.clone();
    ba.merge(&a);
    assert_eq!(ab.get("name"), Some(b"Bob".as_slice()));
    assert_eq!(ba.get("name"), Some(b"Bob".as_slice()));
    assert_eq!(ab.get("bio"), Some(b"hi".as_slice()));

    // Idempotent: merging twice changes nothing.
    ab.merge(&b);
    assert_eq!(ab.get("name"), Some(b"Bob".as_slice()));

    // Stale writes lose: an older dot never overwrites.
    assert!(!ab.insert("name".into(), dot(9, alice), b"Old".to_vec()));
    assert_eq!(ab.get("name"), Some(b"Bob".as_slice()));

    // Same-day ties break deterministically toward the greater author key.
    let mut c = LwwMap::new();
    c.insert("x".into(), dot(5, bob), b"B".to_vec());
    c.insert("x".into(), dot(5, alice), b"A".to_vec());
    assert_eq!(c.get("x"), Some(b"B".as_slice()));
}
