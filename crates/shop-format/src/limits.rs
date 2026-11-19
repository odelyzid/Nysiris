//! Hard size limits enforced by the nysiris-shop provider.
//!
//! These are wire grammar: clients must respect the same caps before
//! proving/writing (mirrored in the browser as `web/src/domain/shop.ts` and
//! checked by `scripts/check-constants.mjs`).

/// Max listing title length in chars.
pub const MAX_TITLE_CHARS: usize = 80;
/// Max listing description length in chars.
pub const MAX_DESCRIPTION_CHARS: usize = 1200;
/// Max order note bytes (a short public note, never shipping data).
pub const MAX_NOTE_BYTES: usize = 500;
/// Max per-order message bytes.
pub const MAX_MESSAGE_BYTES: usize = 1000;
/// Max review body bytes.
pub const MAX_REVIEW_BYTES: usize = 600;
/// Max units of one listing a single order may reserve.
pub const MAX_ORDER_QTY: u32 = 1_000;
/// Max stock a listing may advertise.
pub const MAX_STOCK: u32 = 1_000_000;
/// Max listings returned by one browse page.
pub const MAX_LISTINGS_PAGE: usize = 50;
/// Default listings returned by one browse page.
pub const DEFAULT_LISTINGS_PAGE: usize = 20;
/// Currency is a fixed three-letter code (`USD`, `EUR`, …).
pub const CURRENCY_LEN: usize = 3;
/// Price is an integer count of minor units (cents), never a float.
pub const PRICE_MINOR_UNITS: u64 = 100;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_are_stable() {
        assert_eq!(MAX_TITLE_CHARS, 80);
        assert_eq!(MAX_DESCRIPTION_CHARS, 1200);
        assert_eq!(MAX_NOTE_BYTES, 500);
        assert_eq!(MAX_MESSAGE_BYTES, 1000);
        assert_eq!(MAX_REVIEW_BYTES, 600);
        assert_eq!(MAX_ORDER_QTY, 1_000);
        assert_eq!(MAX_STOCK, 1_000_000);
        assert_eq!(MAX_LISTINGS_PAGE, 50);
        assert_eq!(DEFAULT_LISTINGS_PAGE, 20);
        assert_eq!(CURRENCY_LEN, 3);
        assert_eq!(PRICE_MINOR_UNITS, 100);
    }
}
