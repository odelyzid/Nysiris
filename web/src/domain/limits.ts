/**
 * Browser-side mirror of the wire size caps enforced by the provider
 * (`crates/social-format`). These are the same knobs `scripts/check-constants.mjs`
 * asserts stay in step; change them in Rust first, then here.
 */

/** Max post body bytes (`social_format::limits::MAX_POST_BYTES`). */
export const MAX_POST_BYTES = 1400;
/** Max DM ciphertext bytes after sealing (`social_format::limits::MAX_DM_BYTES`). */
export const MAX_DM_CIPHERTEXT_BYTES = 1800;
