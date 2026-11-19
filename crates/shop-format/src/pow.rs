//! Proof-of-work payload preimages (byte-exact, cross-implementation).
//!
//! The shop provider requires a client PoW per write, verified with
//! `portal_reputation::pow::verify`. That proof binds `(key, payload_hash)`
//! where `payload_hash = SHA256(payload_preimage)` — the *payload* bytes a
//! write claims commit to. These builders produce exactly the bytes the
//! provider verifies, so a browser client must construct the same sequences:
//!
//! ```text
//! listing:  id(16) || version_be64 || price_be64 || stock_be32 || currency(3)
//!           || title || 0x00 || description
//! delete:   id(16)
//! order:    listing(16) || id(16) || qty_be32 || note
//! status:   order(16) || status(1) || note
//! message:  order(16) || body
//! review:   order(16) || seller(32) || rating(1) || body
//! ```

use crate::limits::CURRENCY_LEN;

fn push_str(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(value.as_bytes());
}

pub fn listing_pow_preimage(
    id: &[u8; 16],
    version: u64,
    price: u64,
    stock: u32,
    currency: &[u8; CURRENCY_LEN],
    title: &str,
    description: &str,
) -> Vec<u8> {
    let mut out =
        Vec::with_capacity(16 + 8 + 8 + 4 + CURRENCY_LEN + title.len() + 1 + description.len());
    out.extend_from_slice(id);
    out.extend_from_slice(&version.to_be_bytes());
    out.extend_from_slice(&price.to_be_bytes());
    out.extend_from_slice(&stock.to_be_bytes());
    out.extend_from_slice(currency);
    push_str(&mut out, title);
    out.push(0x00);
    push_str(&mut out, description);
    out
}

pub fn listing_delete_pow_preimage(id: &[u8; 16]) -> Vec<u8> {
    id.to_vec()
}

/// Commit to the exact terms the order signature covers.
pub fn order_pow_preimage(
    listing: &[u8; 16],
    id: &[u8; 16],
    qty: u32,
    price: u64,
    version: u64,
    note: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + 16 + 4 + 8 + 8 + note.len());
    out.extend_from_slice(listing);
    out.extend_from_slice(id);
    out.extend_from_slice(&qty.to_be_bytes());
    out.extend_from_slice(&price.to_be_bytes());
    out.extend_from_slice(&version.to_be_bytes());
    push_str(&mut out, note);
    out
}

pub fn order_status_pow_preimage(order: &[u8; 16], status: u8, note: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + 1 + note.len());
    out.extend_from_slice(order);
    out.push(status);
    push_str(&mut out, note);
    out
}

pub fn order_message_pow_preimage(order: &[u8; 16], body: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + body.len());
    out.extend_from_slice(order);
    push_str(&mut out, body);
    out
}

pub fn review_pow_preimage(order: &[u8; 16], seller: &[u8; 32], rating: u8, body: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + 32 + 1 + body.len());
    out.extend_from_slice(order);
    out.extend_from_slice(seller);
    out.push(rating);
    push_str(&mut out, body);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_preimage_layout_is_frozen() {
        let out = listing_pow_preimage(&[7u8; 16], 2, 1_234, 9, b"USD", "Lamp", "Warm");
        let mut want = vec![7u8; 16];
        want.extend_from_slice(&2u64.to_be_bytes());
        want.extend_from_slice(&1_234u64.to_be_bytes());
        want.extend_from_slice(&9u32.to_be_bytes());
        want.extend_from_slice(b"USD");
        want.extend_from_slice(b"Lamp\0Warm");
        assert_eq!(out, want);
    }

    #[test]
    fn order_preimages_place_ids_first() {
        let mut want = vec![1u8; 16];
        want.extend_from_slice(&[2u8; 16]);
        want.extend_from_slice(&3u32.to_be_bytes());
        want.extend_from_slice(&1234u64.to_be_bytes());
        want.extend_from_slice(&7u64.to_be_bytes());
        want.extend_from_slice(b"hi");
        assert_eq!(
            order_pow_preimage(&[1u8; 16], &[2u8; 16], 3, 1234, 7, "hi"),
            want
        );

        let mut status = vec![9u8; 16];
        status.push(1);
        status.extend_from_slice(b"ok");
        assert_eq!(order_status_pow_preimage(&[9u8; 16], 1, "ok"), status);

        let mut review = vec![4u8; 16];
        review.extend_from_slice(&[8u8; 32]);
        review.push(5);
        review.extend_from_slice(b"great");
        assert_eq!(
            review_pow_preimage(&[4u8; 16], &[8u8; 32], 5, "great"),
            review
        );

        let mut message = vec![6u8; 16];
        message.extend_from_slice(b"hello");
        assert_eq!(order_message_pow_preimage(&[6u8; 16], "hello"), message);

        assert_eq!(listing_delete_pow_preimage(&[3u8; 16]), vec![3u8; 16]);
    }
}
