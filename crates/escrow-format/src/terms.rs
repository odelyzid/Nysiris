//! Bridge between nysiris-shop's frozen order terms and escrow amounts.
//!
//! Doc 16 signs `price` (minor units) and `qty` into every order. Doc 17 fixes
//! XMR prices as piconeros, so for an XMR listing the signed `price` is already
//! the atomic-unit price and the escrow amount is simply `price × qty`. This
//! module is the one place that multiplication and the reference cap are
//! applied; no float and no JSON number coercion enters the payment flow.

use crate::limits::MAX_ESCROW_ATOMIC;

/// Convert a signed shop `(price, qty)` pair into an escrow amount in
/// piconeros. A zero price (a free listing) has no escrow payment.
pub fn atomic_from_shop_terms(price: u64, qty: u32) -> Result<u64, String> {
    if qty == 0 {
        return Err("order quantity must be positive".into());
    }
    if price == 0 {
        return Err("free listings have no escrow payment".into());
    }
    let amount = price
        .checked_mul(u64::from(qty))
        .ok_or("escrow amount overflows u64")?;
    if amount > MAX_ESCROW_ATOMIC {
        return Err("escrow amount exceeds the stagenet reference cap".into());
    }
    Ok(amount)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiplies_shop_terms_without_overflow() {
        assert_eq!(
            atomic_from_shop_terms(1_000_000_000_000, 3).unwrap(),
            3_000_000_000_000
        );
        assert!(atomic_from_shop_terms(1, 0).is_err());
        assert!(atomic_from_shop_terms(0, 1).is_err());
        assert!(atomic_from_shop_terms(u64::MAX, 2).is_err());
        assert!(atomic_from_shop_terms(MAX_ESCROW_ATOMIC + 1, 1).is_err());
    }
}
