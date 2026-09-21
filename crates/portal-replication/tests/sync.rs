//! Sync protocol tests: two replicas converge, forks never land, batches are atomic.
use ed25519_dalek::Signer;
use portal_data::{log::entry_bytes, LogEntry};
use portal_replication::{diff_wants, Heads, Replica};

fn author(seed: u8) -> ([u8; 32], ed25519_dalek::SigningKey) {
    let sk = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    let pk = sk.verifying_key().to_bytes();
    (pk, sk)
}

fn entry(sk: &ed25519_dalek::SigningKey, author: &[u8; 32], seq: u64, obj: u8) -> LogEntry {
    let obj_id = [obj; 32];
    LogEntry {
        author: *author,
        seq,
        obj_id,
        sig: sk.sign(&entry_bytes(author, seq, &obj_id)).to_bytes(),
    }
}

#[test]
fn wants_cover_exactly_the_gap() {
    let (alice, _) = author(1);
    let (bob, _) = author(2);
    let a_hex = hex::encode(alice);
    let b_hex = hex::encode(bob);

    let mut local = Heads::default();
    local.set(a_hex.clone(), 3);
    let mut peer = Heads::default();
    peer.set(a_hex.clone(), 5); // ahead by 2
    peer.set(b_hex.clone(), 1); // new author
    peer.set("00".repeat(32), 0); // zero head: nothing to fetch

    let wants = diff_wants(&local, &peer);
    assert_eq!(wants.len(), 2);
    assert!(wants.contains(&portal_replication::Want {
        author_hex: a_hex,
        from_seq: 3
    }));
    assert!(wants.contains(&portal_replication::Want {
        author_hex: b_hex,
        from_seq: 0
    }));

    // Already converged: silence.
    assert!(diff_wants(&peer, &peer).is_empty());
    // We lead everywhere: the peer asks, we don't.
    assert!(diff_wants(&peer, &local).is_empty());
}

#[test]
fn two_replicas_converge_through_wants() {
    let (alice, ask) = author(1);
    let a_hex = hex::encode(alice);

    let mut full = Replica::new();
    full.apply_entries(vec![
        entry(&ask, &alice, 0, 10),
        entry(&ask, &alice, 1, 11),
        entry(&ask, &alice, 2, 12),
    ])
    .unwrap();

    let mut empty = Replica::new();
    let wants = diff_wants(&empty.heads(), &full.heads());
    assert_eq!(wants.len(), 1);
    assert_eq!(wants[0].from_seq, 0);

    // Simulate serving entries since the want.
    let served: Vec<LogEntry> =
        full.log(&alice).unwrap().entries()[wants[0].from_seq as usize..].to_vec();
    assert_eq!(empty.apply_entries(served).unwrap(), 3);
    assert!(diff_wants(&empty.heads(), &full.heads()).is_empty());
    assert_eq!(empty.heads().get(&a_hex), 3);
}

#[test]
fn batches_apply_atomically_and_forks_never_land() {
    let (alice, ask) = author(1);
    let mut replica = Replica::new();
    replica
        .apply_entries(vec![entry(&ask, &alice, 0, 10)])
        .unwrap();

    // Batch with a gap in the middle: whole batch rejected, head unchanged.
    let bad = vec![entry(&ask, &alice, 1, 11), entry(&ask, &alice, 3, 13)];
    assert!(replica.apply_entries(bad).is_err());
    assert_eq!(replica.heads().get(&hex::encode(alice)), 1);

    // Commit seq 1 legitimately, then a forked entry at the occupied seq.
    replica
        .apply_entries(vec![entry(&ask, &alice, 1, 11)])
        .unwrap();
    assert!(replica
        .apply_entries(vec![entry(&ask, &alice, 1, 99)])
        .is_err());
    assert_eq!(replica.heads().get(&hex::encode(alice)), 2);

    // Mixed-author batch: rejected.
    let (bob, bsk) = author(2);
    let mixed = vec![entry(&ask, &alice, 1, 11), entry(&bsk, &bob, 0, 20)];
    assert!(replica.apply_entries(mixed).is_err());
}

#[test]
fn forged_entries_are_rejected() {
    let (alice, _) = author(1);
    let mut replica = Replica::new();
    let forged = LogEntry {
        author: alice,
        seq: 0,
        obj_id: [1u8; 32],
        sig: [0u8; 64],
    };
    assert!(replica.apply_entries(vec![forged]).is_err());
    assert!(replica.heads().heads.is_empty());
}
