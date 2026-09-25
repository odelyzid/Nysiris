//! Proof-of-work payload preimages (byte-exact, cross-implementation).
//!
//! The social provider requires a client PoW per write, verified with
//! `portal_reputation::pow::verify`. That proof binds `(key, payload_hash)`
//! where `payload_hash = SHA256(payload_preimage)` — the *payload* bytes a
//! write claims commit to. These builders produce exactly the bytes the
//! provider verifies, so a browser client and any future client must
//! construct the same sequences (the dashboard mirrors them inline today):
//!
//! ```text
//! post:     [parent(16) if reply] || body || id(32) of each attachment
//! profile:  name || 0x00 || bio
//! dm:       ciphertext (sender-anonymous: only the recipient key + blob bind)
//! blob:     id(32) || part_be32 || chunk
//! ```
//!
//! Note the post builder *decodes* attachment ids back to raw bytes: that is
//! part of the contract (`web/src/social/identity.ts` does the same). Never
//! hash the hex spelling.

use crate::attach::AttachmentRef;

/// PoW payload preimage for a post. `parent` is the raw 16-byte parent id
/// (or `None` for a top-level post); attachment refs contribute their raw
/// content-address bytes, empty when absent.
pub fn post_pow_preimage(
    parent: Option<&[u8; 16]>,
    body: &[u8],
    attachments: &[AttachmentRef],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + body.len() + 32 * attachments.len());
    if let Some(p) = parent {
        out.extend_from_slice(p);
    }
    out.extend_from_slice(body);
    for a in attachments {
        out.extend_from_slice(&hex::decode(&a.id).unwrap_or_default());
    }
    out
}

/// PoW payload preimage for a profile: `name`, NUL, `bio` — the same bytes
/// the signature covers after the profile domain.
pub fn profile_pow_preimage(name: &str, bio: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(name.len() + 1 + bio.len());
    out.extend_from_slice(name.as_bytes());
    out.push(0x00);
    out.extend_from_slice(bio.as_bytes());
    out
}

/// PoW payload for a DM: the raw ciphertext itself. DMs are sender-anonymous,
/// so the proof binds the *recipient* key and the blob, nothing else.
pub fn dm_pow_payload(ciphertext: &[u8]) -> Vec<u8> {
    ciphertext.to_vec()
}

/// PoW payload preimage for one chunked blob upload part.
pub fn blob_part_pow_preimage(id: &[u8; 32], part: usize, chunk: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 + 4 + chunk.len());
    out.extend_from_slice(id);
    out.extend_from_slice(&(part as u32).to_be_bytes());
    out.extend_from_slice(chunk);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(hex_id: &str) -> AttachmentRef {
        AttachmentRef {
            id: hex_id.into(),
            name: "x.png".into(),
            mime: "image/png".into(),
            size: 1,
            key: "cd".repeat(32),
        }
    }

    #[test]
    fn post_preimage_layout_is_frozen() {
        let body = b"hi";
        // Top-level: no parent bytes (not sixteen zeros — absence is absence).
        let top = post_pow_preimage(None, body, &[]);
        assert_eq!(top, b"hi");
        // Reply: parent first, then body.
        let reply = post_pow_preimage(Some(&[7u8; 16]), body, &[]);
        let mut want = vec![7u8; 16];
        want.extend_from_slice(b"hi");
        assert_eq!(reply, want);
        // Two attachments: content-address bytes appended in ref order.
        let with_atts =
            post_pow_preimage(None, body, &[att(&"ab".repeat(32)), att(&"ff".repeat(32))]);
        let mut want2 = b"hi".to_vec();
        want2.extend_from_slice(&hex::decode("ab".repeat(32)).unwrap());
        want2.extend_from_slice(&hex::decode("ff".repeat(32)).unwrap());
        assert_eq!(with_atts, want2);
        // A malformed id contributes nothing, exactly like the provider.
        let garbage = post_pow_preimage(None, body, &[att("not-hex")]);
        assert_eq!(garbage, b"hi");
    }

    #[test]
    fn profile_preimage_is_name_nul_bio() {
        assert_eq!(profile_pow_preimage("ada", ""), b"ada\0");
        assert_eq!(profile_pow_preimage("", "bio"), b"\0bio");
        assert_eq!(profile_pow_preimage("a", "b"), b"a\0b");
    }

    #[test]
    fn dm_payload_is_the_ciphertext_verbatim() {
        assert_eq!(dm_pow_payload(b"ct"), b"ct");
    }

    #[test]
    fn blob_part_preimage_is_id_part_be32_chunk() {
        let chunk = b"xyz";
        let want = [7u8; 32]
            .iter()
            .copied()
            .chain([0, 0, 0, 5])
            .chain(chunk.iter().copied())
            .collect::<Vec<_>>();
        assert_eq!(blob_part_pow_preimage(&[7u8; 32], 5, chunk), want);
        assert_eq!(
            blob_part_pow_preimage(&[8u8; 32], 0, b""),
            [8u8; 32]
                .into_iter()
                .chain([0, 0, 0, 0])
                .collect::<Vec<_>>()
        );
    }
}
