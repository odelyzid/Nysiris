//! Signature scheme for nysiris-shop (byte-exact, cross-implementation).
//!
//! Identity = ed25519 keypair. The 32-byte public key IS the account. Every
//! write is signed; the provider verifies before touching SQLite, and any
//! client can re-verify on read. Unsigned writes are dropped.
//!
//! Domains (domain-separated, concatenation, no length prefixes — fixed-size
//! fields come first, the variable field is always last):
//!
//! ```text
//! listing:       b"fly-shop-v1/listing"        || seller(32) || day_be64 || id(16)
//!                || version_be64 || price_be64 || stock_be32 || currency(3)
//!                || title || 0x00 || description
//! listing-del:   b"fly-shop-v1/listing-delete"  || seller(32) || id(16) || day_be64
//! order:         b"fly-shop-v1/order"           || buyer(32)  || day_be64 || listing(16)
//!                || id(16) || qty_be32 || note
//! order-status:  b"fly-shop-v1/order-status"    || actor(32)  || day_be64 || order(16)
//!                || status(1) || note
//! orders-read:   b"fly-shop-v1/orders-read"     || for(32)    || day_be64
//! order-message: b"fly-shop-v1/order-message"   || author(32) || day_be64 || order(16) || body
//! review:        b"fly-shop-v1/review"          || author(32) || day_be64 || order(16)
//!                || seller(32) || rating(1) || body
//! ```
//!
//! `title`/`description`/`note`/`body` are UTF-8 and NUL-free (the provider
//! rejects interior NULs), so the NUL separator in the listing layout is
//! unambiguous. Prices are integer **minor units** (cents); currency is a
//! fixed three-letter uppercase code. No floats ever cross the wire.
//!
//! `day` is a coarse UTC day number (`unix_time / 86400`), not a timestamp:
//! the provider never sees precise times. The same construction must be used
//! by the browser client (`web/src/domain/shop.ts`).

use ed25519_dalek::{Signature, Verifier, VerifyingKey};

#[cfg(test)]
use ed25519_dalek::{Signer, SigningKey};

pub const LISTING_DOMAIN: &[u8] = b"fly-shop-v1/listing";
pub const LISTING_DELETE_DOMAIN: &[u8] = b"fly-shop-v1/listing-delete";
pub const ORDER_DOMAIN: &[u8] = b"fly-shop-v1/order";
pub const ORDER_STATUS_DOMAIN: &[u8] = b"fly-shop-v1/order-status";
pub const ORDERS_READ_DOMAIN: &[u8] = b"fly-shop-v1/orders-read";
pub const ORDER_MESSAGE_DOMAIN: &[u8] = b"fly-shop-v1/order-message";
pub const REVIEW_DOMAIN: &[u8] = b"fly-shop-v1/review";

/// Current UTC day number (coarse time for every signed write).
pub fn current_day() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0)
}

/// A three-letter uppercase currency code. Rejects anything else, including
/// lookalike Unicode — this is a wire field, not a display string.
pub fn parse_currency(s: &str) -> Result<[u8; 3], String> {
    let b = s.as_bytes();
    if b.len() != 3 || !b.iter().all(|c| c.is_ascii_uppercase()) {
        return Err("currency must be a 3-letter uppercase code".into());
    }
    let mut out = [0u8; 3];
    out.copy_from_slice(b);
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
pub fn listing_message(
    seller: &[u8; 32],
    day: u64,
    id: &[u8; 16],
    version: u64,
    price: u64,
    stock: u32,
    currency: &[u8; 3],
    title: &str,
    description: &str,
) -> Vec<u8> {
    let mut m = Vec::with_capacity(
        LISTING_DOMAIN.len() + 32 + 8 + 16 + 8 + 8 + 4 + 3 + title.len() + 1 + description.len(),
    );
    m.extend_from_slice(LISTING_DOMAIN);
    m.extend_from_slice(seller);
    m.extend_from_slice(&day.to_be_bytes());
    m.extend_from_slice(id);
    m.extend_from_slice(&version.to_be_bytes());
    m.extend_from_slice(&price.to_be_bytes());
    m.extend_from_slice(&stock.to_be_bytes());
    m.extend_from_slice(currency);
    m.extend_from_slice(title.as_bytes());
    m.push(0x00);
    m.extend_from_slice(description.as_bytes());
    m
}

pub fn listing_delete_message(seller: &[u8; 32], id: &[u8; 16], day: u64) -> Vec<u8> {
    let mut m = Vec::with_capacity(LISTING_DELETE_DOMAIN.len() + 32 + 16 + 8);
    m.extend_from_slice(LISTING_DELETE_DOMAIN);
    m.extend_from_slice(seller);
    m.extend_from_slice(id);
    m.extend_from_slice(&day.to_be_bytes());
    m
}

pub fn order_message(
    buyer: &[u8; 32],
    day: u64,
    listing: &[u8; 16],
    id: &[u8; 16],
    qty: u32,
    note: &str,
) -> Vec<u8> {
    let mut m = Vec::with_capacity(ORDER_DOMAIN.len() + 32 + 8 + 16 + 16 + 4 + note.len());
    m.extend_from_slice(ORDER_DOMAIN);
    m.extend_from_slice(buyer);
    m.extend_from_slice(&day.to_be_bytes());
    m.extend_from_slice(listing);
    m.extend_from_slice(id);
    m.extend_from_slice(&qty.to_be_bytes());
    m.extend_from_slice(note.as_bytes());
    m
}

pub fn order_status_message(
    actor: &[u8; 32],
    day: u64,
    order: &[u8; 16],
    status: u8,
    note: &str,
) -> Vec<u8> {
    let mut m = Vec::with_capacity(ORDER_STATUS_DOMAIN.len() + 32 + 8 + 16 + 1 + note.len());
    m.extend_from_slice(ORDER_STATUS_DOMAIN);
    m.extend_from_slice(actor);
    m.extend_from_slice(&day.to_be_bytes());
    m.extend_from_slice(order);
    m.push(status);
    m.extend_from_slice(note.as_bytes());
    m
}

/// Proof-of-possession for the private order list. The buyer and seller keys
/// are public (they sign every write), so an unauthenticated `GET /orders`
/// would expose who bought what. The signature covers
/// `domain || for(32) || day_be64`, bounding its use to the same ±2-day
/// freshness window as every other write.
pub fn orders_read_message(for_key: &[u8; 32], day: u64) -> Vec<u8> {
    let mut m = Vec::with_capacity(ORDERS_READ_DOMAIN.len() + 32 + 8);
    m.extend_from_slice(ORDERS_READ_DOMAIN);
    m.extend_from_slice(for_key);
    m.extend_from_slice(&day.to_be_bytes());
    m
}

pub fn order_message_body(author: &[u8; 32], day: u64, order: &[u8; 16], body: &str) -> Vec<u8> {
    let mut m = Vec::with_capacity(ORDER_MESSAGE_DOMAIN.len() + 32 + 8 + 16 + body.len());
    m.extend_from_slice(ORDER_MESSAGE_DOMAIN);
    m.extend_from_slice(author);
    m.extend_from_slice(&day.to_be_bytes());
    m.extend_from_slice(order);
    m.extend_from_slice(body.as_bytes());
    m
}

pub fn review_message(
    author: &[u8; 32],
    day: u64,
    order: &[u8; 16],
    seller: &[u8; 32],
    rating: u8,
    body: &str,
) -> Vec<u8> {
    let mut m = Vec::with_capacity(REVIEW_DOMAIN.len() + 32 + 8 + 16 + 32 + 1 + body.len());
    m.extend_from_slice(REVIEW_DOMAIN);
    m.extend_from_slice(author);
    m.extend_from_slice(&day.to_be_bytes());
    m.extend_from_slice(order);
    m.extend_from_slice(seller);
    m.push(rating);
    m.extend_from_slice(body.as_bytes());
    m
}

pub fn parse_pubkey(hex_str: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(hex_str.trim()).map_err(|e| format!("pubkey not hex: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("pubkey must be 32 bytes, got {}", bytes.len()));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    // Reject non-canonical and small-order points up front so bad keys fail
    // fast, not deep in SQL. (Small-order keys have known discrete logs, so
    // anyone could sign as that "identity".)
    let key = VerifyingKey::from_bytes(&out).map_err(|e| format!("bad ed25519 point: {e}"))?;
    if key.is_weak() {
        return Err("weak (small-order) ed25519 key".into());
    }
    Ok(out)
}

pub fn parse_sig(hex_str: &str) -> Result<Signature, String> {
    let bytes = hex::decode(hex_str.trim()).map_err(|e| format!("sig not hex: {e}"))?;
    if bytes.len() != 64 {
        return Err(format!("sig must be 64 bytes, got {}", bytes.len()));
    }
    let mut arr = [0u8; 64];
    arr.copy_from_slice(&bytes);
    Ok(Signature::from_bytes(&arr))
}

pub fn verify(author: &[u8; 32], message: &[u8], sig: &Signature) -> Result<(), String> {
    let key = VerifyingKey::from_bytes(author).map_err(|e| format!("bad key: {e}"))?;
    key.verify(message, sig)
        .map_err(|e| format!("bad signature: {e}"))
}

/// Test helper: sign with a raw 32-byte secret.
#[cfg(test)]
pub fn sign_with(secret: &[u8; 32], message: &[u8]) -> (SigningKey, Signature) {
    let sk = SigningKey::from_bytes(secret);
    let sig = sk.sign(message);
    (sk, sig)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listing_sig(secret: &[u8; 32]) -> (SigningKey, Signature, Vec<u8>) {
        let sk = SigningKey::from_bytes(secret);
        let seller = sk.verifying_key().to_bytes();
        let msg = listing_message(
            &seller,
            20_400,
            &[0xab; 16],
            1,
            12_34,
            7,
            b"USD",
            "Desk lamp",
            "Warm light, small scratch.",
        );
        let sig = sk.sign(&msg);
        (sk, sig, msg)
    }

    #[test]
    fn listing_signs_and_verifies() {
        let (_, sig, msg) = listing_sig(&[7u8; 32]);
        let seller = SigningKey::from_bytes(&[7u8; 32])
            .verifying_key()
            .to_bytes();
        verify(&seller, &msg, &sig).unwrap();
    }

    #[test]
    fn listing_fields_are_bound_into_the_signature() {
        let (_, sig, _) = listing_sig(&[7u8; 32]);
        let seller = SigningKey::from_bytes(&[7u8; 32])
            .verifying_key()
            .to_bytes();

        // Changing the price, stock, version, or currency breaks the signature.
        for msg in [
            listing_message(
                &seller,
                20_400,
                &[0xab; 16],
                1,
                12_35,
                7,
                b"USD",
                "Desk lamp",
                "Warm light, small scratch.",
            ),
            listing_message(
                &seller,
                20_400,
                &[0xab; 16],
                1,
                12_34,
                8,
                b"USD",
                "Desk lamp",
                "Warm light, small scratch.",
            ),
            listing_message(
                &seller,
                20_400,
                &[0xab; 16],
                2,
                12_34,
                7,
                b"USD",
                "Desk lamp",
                "Warm light, small scratch.",
            ),
            listing_message(
                &seller,
                20_400,
                &[0xab; 16],
                1,
                12_34,
                7,
                b"EUR",
                "Desk lamp",
                "Warm light, small scratch.",
            ),
            listing_message(
                &seller,
                20_400,
                &[0xcd; 16],
                1,
                12_34,
                7,
                b"USD",
                "Desk lamp",
                "Warm light, small scratch.",
            ),
            listing_message(
                &seller,
                20_400,
                &[0xab; 16],
                1,
                12_34,
                7,
                b"USD",
                "Desk lamp",
                "Warm light.",
            ),
        ] {
            assert!(verify(&seller, &msg, &sig).is_err());
        }
    }

    #[test]
    fn order_status_and_review_layouts_bind_their_fields() {
        let sk = SigningKey::from_bytes(&[9u8; 32]);
        let who = sk.verifying_key().to_bytes();
        let order = [3u8; 16];

        let status = order_status_message(&who, 20_400, &order, 1, "accepted");
        let sig = sk.sign(&status);
        verify(&who, &status, &sig).unwrap();
        let other = order_status_message(&who, 20_400, &order, 2, "accepted");
        assert!(verify(&who, &other, &sig).is_err());

        let review = review_message(&who, 20_400, &order, &[8u8; 32], 5, "exactly as described");
        let rsig = sk.sign(&review);
        verify(&who, &review, &rsig).unwrap();
        let one_star = review_message(&who, 20_400, &order, &[8u8; 32], 1, "exactly as described");
        assert!(verify(&who, &one_star, &rsig).is_err());
        // The seller is signed too, so a provider cannot reassign a review.
        let other_seller =
            review_message(&who, 20_400, &order, &[9u8; 32], 5, "exactly as described");
        assert!(verify(&who, &other_seller, &rsig).is_err());

        let read = orders_read_message(&who, 20_400);
        let sig = sk.sign(&read);
        verify(&who, &read, &sig).unwrap();
        // Can't replay the proof onto another key or day.
        assert!(verify(&who, &orders_read_message(&[8u8; 32], 20_400), &sig).is_err());
        assert!(verify(&who, &orders_read_message(&who, 20_401), &sig).is_err());
    }

    #[test]
    fn currency_parser_is_strict() {
        assert_eq!(parse_currency("USD").unwrap(), *b"USD");
        for bad in ["usd", "US", "USDD", "U5D", "ＵＳＤ"] {
            assert!(parse_currency(bad).is_err(), "{bad} accepted");
        }
    }

    #[test]
    fn cross_implementation_vectors() {
        // Fixed vectors mirrored by `web/test/shop.test.mjs`. ed25519 is
        // deterministic, so both implementations must emit these exact bytes.
        let sk = SigningKey::from_bytes(&[42u8; 32]);
        let seller = sk.verifying_key().to_bytes();
        assert_eq!(
            hex::encode(seller),
            "197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61"
        );
        let listing = listing_message(
            &seller,
            20_400,
            &[0xab; 16],
            1,
            1_234,
            7,
            b"USD",
            "Desk lamp",
            "Warm light, small scratch.",
        );
        assert_eq!(
            hex::encode(sk.sign(&listing).to_bytes()),
            "0927b9355d4d781397bc160a6552eede07f54fd1462878b341dcbc349785a020c8a1213dd5d867a603c539d7ab452cd50431c397bcc87ede6ad409552ea5f408"
        );
        let order = order_message(
            &seller,
            20_400,
            &[0xcd; 16],
            &[0xef; 16],
            3,
            "please pack well",
        );
        assert_eq!(
            hex::encode(sk.sign(&order).to_bytes()),
            "73e192feee0799df56a674c836217ca0c0582b6915b3cf3ae2fe5eb2d1b6254ad19ba1cf4cee22cbc9720842454bbb18ca6dfac1f4b07ebaeb0313e7126f9c01"
        );
        let status = order_status_message(&seller, 20_400, &[0xef; 16], 1, "accepted");
        assert_eq!(
            hex::encode(sk.sign(&status).to_bytes()),
            "ade3a17c992f515bae5ec90f488f00b148a5b827329153944654ed952362fc05aec9e3a5b56c2f7ffd81210a70edc3e47264060d9efeadb6d1277126f609f001"
        );
        let review = review_message(
            &seller,
            20_400,
            &[0xef; 16],
            &[0x11; 32],
            5,
            "exactly as described",
        );
        assert_eq!(
            hex::encode(sk.sign(&review).to_bytes()),
            "cb07824e765ec85b4c83b278b9efcf4693bf12dd31709e3e85bf94d2a0fca2cdca92e45e7de7eaef19f4c1b6ff8b29da8946c917a840b76fd4fbb758b6a93304"
        );
        let read = orders_read_message(&seller, 20_400);
        assert_eq!(
            hex::encode(sk.sign(&read).to_bytes()),
            "3574ea77bbfec57ffed516d9368d912b962561d9e7e6fbc43f5786a8d0d8a9128af6c0ff095b270c78f2253192cd95d0d50c0bf05f8f5d453ed7b6d2de035a04"
        );
    }

    #[test]
    fn rejects_malformed_keys_and_signatures() {
        assert!(parse_pubkey("zz").is_err());
        assert!(parse_pubkey(&"00".repeat(32)).is_err());
        assert!(parse_sig(&"ab".repeat(63)).is_err());
    }
}
