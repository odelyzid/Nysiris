//! Encrypted attachments for posts and DMs (byte-exact, cross-implementation).
//!
//! Model: a file is encrypted client-side (XChaCha20-Poly1305, random 32-byte
//! file key, blob = `nonce(24) || ct`), and the *ciphertext blob* is stored
//! under its content address `id = SHA256(blob)` (the same hash as
//! `portal_reputation::pow::payload_hash`, so no new dependency). The
//! post/DM envelope carries only metadata + key material:
//!
//! ```text
//! AttachmentRef canonical bytes (appended to the signed message, §sig):
//!   per ref: id(32) || mime_len(1) || mime || name_len(1) || name || size_be64(8) || key(32)
//!   (empty when there are no attachments — legacy messages sign identically)
//! ```
//!
//! Key transport: timeline posts are public, so the file key rides in the
//! post metadata in the clear (the blob stays confidential against the
//! provider and network observers). DMs seal the whole inner envelope to the
//! recipient, so attachment keys inside a DM are confidential end-to-end.
//! The service never sees keys or plaintext: it stores opaque blobs.
//!
//! Hard limits (mirrored in `web/src/social/attachments.ts`):
//! * ciphertext blob ≤ 256 KiB, at most 3 attachments per post/DM,
//! * 7 whitelisted MIME types, filenames ≤ 80 chars, no path separators.

use serde::{Deserialize, Serialize};

/// Max ciphertext blob size: 256 KiB (nonce +Poly1305 overhead included).
pub const MAX_ATTACHMENT_BYTES: usize = 262_144;
/// Max attachments carried by one post or DM.
pub const MAX_ATTACHMENTS_PER_MESSAGE: usize = 3;
/// Max filename length in chars (sanitized client-side, enforced here).
pub const MAX_FILENAME_CHARS: usize = 80;

/// Upload chunking: request envelopes are capped at 64 KiB
/// (`bridge_guard::DEFAULT_MAX_BODY_BYTES`), so blobs travel as one envelope
/// per chunk (`POST /blob/part?id=<hex>&part=<i>&of=<n>`). Raw chunks stay
/// well under the cap once base64 + JSON overhead is added.
pub const MAX_BLOB_PART_BYTES: usize = 45_056; // 44 KiB
/// Max parts per blob: covers the 256 KiB cap with room to spare.
pub const MAX_BLOB_PARTS: usize = 8;
/// Staged (incomplete) uploads older than this are pruned on write.
pub const BLOB_STAGING_TTL_SECS: u64 = 3_600;

/// Whitelisted MIME types. Anything else is rejected before encryption.
pub const ALLOWED_MIMES: [&str; 7] = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "text/plain",
    "text/markdown",
    "application/pdf",
];

/// Attachment metadata as carried in a post or (sealed) DM envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentRef {
    /// Content address: SHA256(ciphertext blob), lowercase hex (64 chars).
    pub id: String,
    /// Sanitized original filename.
    pub name: String,
    /// Whitelisted MIME type.
    pub mime: String,
    /// Plaintext size in bytes (UI + pre-download check).
    pub size: u64,
    /// File key: 32 bytes, lowercase hex (64 chars).
    pub key: String,
}

pub fn mime_allowed(mime: &str) -> bool {
    ALLOWED_MIMES.contains(&mime)
}

/// Canonical bytes of an attachment list for signature binding. Empty when
/// there are no attachments, so legacy (attachment-free) messages sign and
/// verify byte-identically to before.
pub fn canonical_attachments(atts: &[AttachmentRef]) -> Vec<u8> {
    let mut out = Vec::new();
    for a in atts {
        let id = hex::decode(a.id.trim()).unwrap_or_default();
        let key = hex::decode(a.key.trim()).unwrap_or_default();
        out.extend_from_slice(&id);
        out.push(a.mime.len() as u8);
        out.extend_from_slice(a.mime.as_bytes());
        out.push(a.name.len() as u8);
        out.extend_from_slice(a.name.as_bytes());
        out.extend_from_slice(&a.size.to_be_bytes());
        out.extend_from_slice(&key);
    }
    out
}

fn parse_hex_id(hex_str: &str, what: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(hex_str.trim()).map_err(|_| format!("{what} must be hex"))?;
    if bytes.len() != 32 {
        return Err(format!("{what} must be 32 bytes"));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Validate + parse the optional `attachments` array of a post/DM envelope.
/// Returns the refs (for signature verification) or an error for the client.
pub fn parse_attachments(v: &serde_json::Value) -> Result<Vec<AttachmentRef>, String> {
    let arr = match v.get("attachments") {
        None => return Ok(Vec::new()),
        Some(a) => a.as_array().ok_or("attachments must be an array")?.clone(),
    };
    if arr.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(format!(
            "at most {MAX_ATTACHMENTS_PER_MESSAGE} attachments per message"
        ));
    }
    let mut out = Vec::with_capacity(arr.len());
    for item in &arr {
        let id_hex = item
            .get("id")
            .and_then(|s| s.as_str())
            .ok_or("attachment id must be a hex string")?;
        let id = parse_hex_id(id_hex, "attachment id")?;
        let key_hex = item
            .get("key")
            .and_then(|s| s.as_str())
            .ok_or("attachment key must be a hex string")?;
        let key = parse_hex_id(key_hex, "attachment key")?;
        let mime = item
            .get("mime")
            .and_then(|s| s.as_str())
            .ok_or("attachment mime must be a string")?;
        if !mime_allowed(mime) {
            return Err(format!("attachment MIME not allowed: {mime}"));
        }
        let name = item
            .get("name")
            .and_then(|s| s.as_str())
            .ok_or("attachment name must be a string")?;
        validate_filename(name)?;
        let size = item
            .get("size")
            .and_then(|s| s.as_u64())
            .ok_or("attachment size must be a non-negative integer")?;
        // Ciphertext is plaintext + 40 bytes (24 nonce + 16 tag); bounding
        // the plaintext by the blob cap keeps every stored blob in range.
        if size > MAX_ATTACHMENT_BYTES as u64 {
            return Err(format!("attachment too large (max {MAX_ATTACHMENT_BYTES} bytes)"));
        }
        out.push(AttachmentRef {
            id: hex::encode(id),
            name: name.to_string(),
            mime: mime.to_string(),
            size,
            key: hex::encode(key),
        });
    }
    Ok(out)
}

/// Server-side filename rules (the client sanitizes first; this is the
/// backstop): short, no path separators, no control characters.
pub fn validate_filename(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("attachment name must not be empty".into());
    }
    if name.chars().count() > MAX_FILENAME_CHARS {
        return Err(format!(
            "attachment name too long (max {MAX_FILENAME_CHARS} chars)"
        ));
    }
    // The canonical signature encoding uses single length bytes.
    if name.len() > 255 {
        return Err("attachment name too long in bytes".into());
    }
    if name.contains(['/', '\\', '\0']) || name.chars().any(|c| c.is_control()) {
        return Err("attachment name must not contain path separators or control characters".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_ref() -> AttachmentRef {
        AttachmentRef {
            id: "ab".repeat(32),
            name: "photo.png".into(),
            mime: "image/png".into(),
            size: 1234,
            key: "cd".repeat(32),
        }
    }

    #[test]
    fn canonical_is_empty_without_attachments() {
        assert!(canonical_attachments(&[]).is_empty());
    }

    #[test]
    fn canonical_is_deterministic_and_size_sensitive() {
        let a = canonical_attachments(&[sample_ref()]);
        let b = canonical_attachments(&[sample_ref()]);
        assert_eq!(a, b);
        let mut other = sample_ref();
        other.size += 1;
        assert_ne!(a, canonical_attachments(&[other]));
        let mut renamed = sample_ref();
        renamed.name = "other.png".into();
        assert_ne!(a, canonical_attachments(&[renamed]));
    }

    #[test]
    fn rejects_bad_envelopes() {
        let bad_mime = serde_json::json!([{ "id": "ab".repeat(32), "name": "x.bin",
            "mime": "application/octet-stream", "size": 1, "key": "cd".repeat(32) }]);
        assert!(parse_attachments(&serde_json::json!({ "attachments": bad_mime })).is_err());

        let too_many: Vec<_> = (0..4).map(|_| serde_json::json!(
            { "id": "ab".repeat(32), "name": "x.png", "mime": "image/png", "size": 1, "key": "cd".repeat(32) })).collect();
        assert!(parse_attachments(&serde_json::json!({ "attachments": too_many })).is_err());

        let bad_name = serde_json::json!([{ "id": "ab".repeat(32), "name": "../evil",
            "mime": "image/png", "size": 1, "key": "cd".repeat(32) }]);
        assert!(parse_attachments(&serde_json::json!({ "attachments": bad_name })).is_err());

        let oversize = serde_json::json!([{ "id": "ab".repeat(32), "name": "x.png",
            "mime": "image/png", "size": MAX_ATTACHMENT_BYTES as u64 + 1, "key": "cd".repeat(32) }]);
        assert!(parse_attachments(&serde_json::json!({ "attachments": oversize })).is_err());

        // Absent array means no attachments (legacy messages).
        assert_eq!(parse_attachments(&serde_json::json!({})).unwrap(), vec![]);
    }

    #[test]
    fn accepts_a_valid_envelope() {
        let v = serde_json::json!({ "attachments": [{
            "id": "ab".repeat(32), "name": "note.md", "mime": "text/markdown",
            "size": 42, "key": "cd".repeat(32) }] });
        let refs = parse_attachments(&v).unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].mime, "text/markdown");
    }
}
