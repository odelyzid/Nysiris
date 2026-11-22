//! Print signed test vectors for the browser mirror (`web/test/escrow.test.mjs`).
//!
//! Run with: `cargo run -p escrow-format --example vectors`
//! The output is deterministic: fixed keys, day, order, nonce, and payloads.

use ed25519_dalek::SigningKey;
use escrow_format::message::{
    approve_message, cancel_message, commit_message, dispute_message, funded_message, join_message,
    open_message, release_message, resolve_message, setup_transcript_hash, sign_message,
    submitted_message,
};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn key(byte: u8) -> SigningKey {
    SigningKey::from_bytes(&[byte; 32])
}

const DAY: u64 = 20_400;
const ORDER: [u8; 16] = [0xab; 16];
const NONCE: [u8; 16] = [0xcd; 16];
const AMOUNT: u64 = 1_234_000_000_000;

fn main() {
    let priv_key = key(0x2a);
    let actor = priv_key.verifying_key().to_bytes();
    let seller = [0x11; 32];
    let arbiter = [0x22; 32];
    let address = b"5StagenetEscrow";
    let transcript = setup_transcript_hash(&ORDER, &NONCE, address);
    let release = sign_message(
        release_message(
            &actor,
            DAY,
            9,
            &ORDER,
            &NONCE,
            b"56Payout",
            AMOUNT,
            &[0x03; 32],
            &[0x04; 32],
        )
        .unwrap(),
        &priv_key,
    );
    let dispute = sign_message(
        dispute_message(&actor, DAY, 9, &ORDER, &NONCE, 1, b"not delivered").unwrap(),
        &priv_key,
    );

    // One envelope per domain, byte-exact against the web builders/decoder.
    let vectors: Vec<(&str, Vec<u8>)> = vec![
        (
            "OPEN",
            sign_message(
                open_message(
                    &actor, DAY, 7, &ORDER, &NONCE, &seller, &arbiter, AMOUNT, b"XMR",
                )
                .unwrap(),
                &priv_key,
            ),
        ),
        (
            "JOIN",
            sign_message(
                join_message(&actor, DAY, 8, &ORDER, &NONCE, 0, b"MultisigxV2ABC").unwrap(),
                &priv_key,
            ),
        ),
        (
            "COMMIT",
            sign_message(
                commit_message(&actor, DAY, 9, &ORDER, &NONCE, 3, address, &transcript).unwrap(),
                &priv_key,
            ),
        ),
        (
            "FUNDED",
            sign_message(
                funded_message(
                    &actor,
                    DAY,
                    10,
                    &ORDER,
                    &NONCE,
                    &[0x33; 32],
                    AMOUNT,
                    b"proof",
                )
                .unwrap(),
                &priv_key,
            ),
        ),
        ("RELEASE", release.clone()),
        (
            "APPROVE",
            sign_message(
                approve_message(
                    &actor,
                    DAY,
                    11,
                    &ORDER,
                    &NONCE,
                    &escrow_format::digest(&release),
                    0,
                )
                .unwrap(),
                &priv_key,
            ),
        ),
        ("DISPUTE", dispute.clone()),
        (
            "RESOLVE",
            sign_message(
                resolve_message(
                    &actor,
                    DAY,
                    12,
                    &ORDER,
                    &NONCE,
                    &escrow_format::digest(&dispute),
                    1,
                    b"5BuyerRefund",
                    &[0x07; 32],
                )
                .unwrap(),
                &priv_key,
            ),
        ),
        (
            "CANCEL",
            sign_message(
                cancel_message(&actor, DAY, 13, &ORDER, &NONCE, 0).unwrap(),
                &priv_key,
            ),
        ),
        (
            "SUBMITTED",
            sign_message(
                submitted_message(&actor, DAY, 14, &ORDER, &NONCE, &[0x08; 32], 0).unwrap(),
                &priv_key,
            ),
        ),
    ];
    println!("// One envelope per domain");
    for (name, bytes) in vectors {
        println!("const {name} = '{}';", hex(&bytes));
    }

    // A complete three-party happy path, in relay acceptance order.
    let buyer = key(0x01);
    let seller_key = key(0x02);
    let arbiter_key = key(0x03);
    let b = buyer.verifying_key().to_bytes();
    let s = seller_key.verifying_key().to_bytes();
    let r = arbiter_key.verifying_key().to_bytes();
    let lifecycle_release = sign_message(
        release_message(
            &s,
            DAY,
            2,
            &ORDER,
            &NONCE,
            b"5Seller",
            AMOUNT,
            &[0x44; 32],
            &[0x55; 32],
        )
        .unwrap(),
        &seller_key,
    );
    let lifecycle: Vec<Vec<u8>> = vec![
        sign_message(
            open_message(&b, DAY, 0, &ORDER, &NONCE, &s, &r, AMOUNT, b"XMR").unwrap(),
            &buyer,
        ),
        sign_message(
            join_message(&b, DAY, 1, &ORDER, &NONCE, 0, b"b").unwrap(),
            &buyer,
        ),
        sign_message(
            join_message(&s, DAY, 0, &ORDER, &NONCE, 1, b"s").unwrap(),
            &seller_key,
        ),
        sign_message(
            join_message(&r, DAY, 0, &ORDER, &NONCE, 2, b"r").unwrap(),
            &arbiter_key,
        ),
        sign_message(
            commit_message(&b, DAY, 2, &ORDER, &NONCE, 3, address, &transcript).unwrap(),
            &buyer,
        ),
        sign_message(
            commit_message(&s, DAY, 1, &ORDER, &NONCE, 3, address, &transcript).unwrap(),
            &seller_key,
        ),
        sign_message(
            commit_message(&r, DAY, 1, &ORDER, &NONCE, 3, address, &transcript).unwrap(),
            &arbiter_key,
        ),
        sign_message(
            funded_message(&b, DAY, 3, &ORDER, &NONCE, &[0x66; 32], AMOUNT, b"proof").unwrap(),
            &buyer,
        ),
        lifecycle_release.clone(),
        sign_message(
            approve_message(
                &b,
                DAY,
                4,
                &ORDER,
                &NONCE,
                &escrow_format::digest(&lifecycle_release),
                0,
            )
            .unwrap(),
            &buyer,
        ),
        sign_message(
            submitted_message(&s, DAY, 3, &ORDER, &NONCE, &[0x77; 32], 0).unwrap(),
            &seller_key,
        ),
    ];
    println!();
    println!("// Full three-party happy-path log");
    println!("const LIFECYCLE = [");
    for msg in lifecycle {
        println!("  '{}',", hex(&msg));
    }
    println!("];");
}
