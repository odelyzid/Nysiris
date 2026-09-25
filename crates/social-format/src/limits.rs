//! Hard size limits enforced by the nysiris-social provider.
//!
//! These are wire grammar: clients must respect the same caps before
//! proving/writing (mirrored in the browser as `MAX_DM_BYTES` in
//! `web/src/social/dm.ts`, `1400` in `web/src/social/Social.tsx`, and checked
//! by `scripts/check-constants.mjs`).

/// DM lifetime in seconds (7 days). Expired DMs are pruned on write.
pub const DM_TTL_SECS: u64 = 7 * 86_400;

/// Max post body bytes (also bounded by the envelope cap upstream).
pub const MAX_POST_BYTES: usize = 1400;
/// Max profile display-name length in chars.
pub const MAX_NAME_CHARS: usize = 40;
/// Max profile bio length in chars.
pub const MAX_BIO_CHARS: usize = 280;
/// Max DM ciphertext bytes (XChaCha20-Poly1305 output).
pub const MAX_DM_BYTES: usize = 1800;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_and_sizes_are_stable() {
        assert_eq!(DM_TTL_SECS, 604_800);
        assert_eq!(MAX_POST_BYTES, 1400);
        assert_eq!(MAX_NAME_CHARS, 40);
        assert_eq!(MAX_BIO_CHARS, 280);
        assert_eq!(MAX_DM_BYTES, 1800);
    }
}
