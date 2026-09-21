//! Content-addressed signed objects.
//!
//! ```text
//! signing_bytes = b"fly-portal-v1/object" || author(32) || kind || 0x00 || payload
//! id            = SHA256(signing_bytes || sig)
//! ```
//!
//! The id binds author, kind, payload, and signature: any tampering changes
//! the id, so references to objects are self-checking. Unknown `kind` values
//! are storable but never rendered unless the client knows them.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json;
use sha2::{Digest, Sha256};

pub const OBJECT_DOMAIN: &[u8] = b"fly-portal-v1/object";
/// Payload cap: objects stay small enough to move in few packets; larger
/// content travels as `chunk`-split `dm-chunk`-style objects.
pub const MAX_OBJECT_BYTES: usize = 16 * 1024;
pub const MAX_KIND_LEN: usize = 64;

/// A verified, content-addressed object.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Object {
    pub kind: String,
    pub author: [u8; 32],
    pub payload: Vec<u8>,
    pub sig: [u8; 64],
    pub id: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObjectError {
    BadKind,
    BadAuthor(String),
    BadPayload(String),
    BadSignature(String),
    BadId,
    Oversized,
}

impl std::fmt::Display for ObjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ObjectError::BadKind => write!(f, "kind must be 1-64 chars of [a-z0-9/_-]"),
            ObjectError::BadAuthor(e) => write!(f, "bad author key: {e}"),
            ObjectError::BadPayload(e) => write!(f, "bad payload: {e}"),
            ObjectError::BadSignature(e) => write!(f, "bad signature: {e}"),
            ObjectError::BadId => write!(f, "id does not match content"),
            ObjectError::Oversized => write!(f, "object exceeds size cap"),
        }
    }
}

impl std::error::Error for ObjectError {}

fn valid_kind(kind: &str) -> bool {
    !kind.is_empty()
        && kind.len() <= MAX_KIND_LEN
        && kind.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'/' | b'_' | b'-')
        })
}

pub fn signing_bytes(author: &[u8; 32], kind: &str, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(OBJECT_DOMAIN.len() + 32 + kind.len() + 1 + payload.len());
    out.extend_from_slice(OBJECT_DOMAIN);
    out.extend_from_slice(author);
    out.extend_from_slice(kind.as_bytes());
    out.push(0x00);
    out.extend_from_slice(payload);
    out
}

pub fn compute_id(author: &[u8; 32], kind: &str, payload: &[u8], sig: &[u8; 64]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(signing_bytes(author, kind, payload));
    hasher.update(sig);
    hasher.finalize().into()
}

impl Object {
    /// Build + sign is the author's job (browser side); this constructor is
    /// for tests and tooling.
    pub fn sign_new(
        signing_key: &ed25519_dalek::SigningKey,
        kind: &str,
        payload: Vec<u8>,
    ) -> Result<Self, ObjectError> {
        use ed25519_dalek::Signer;
        if !valid_kind(kind) {
            return Err(ObjectError::BadKind);
        }
        if payload.len() > MAX_OBJECT_BYTES {
            return Err(ObjectError::Oversized);
        }
        let author = signing_key.verifying_key().to_bytes();
        let sig = signing_key
            .sign(&signing_bytes(&author, kind, &payload))
            .to_bytes();
        let id = compute_id(&author, kind, &payload, &sig);
        Ok(Self {
            kind: kind.to_string(),
            author,
            payload,
            sig,
            id,
        })
    }

    /// Verify and ingest an untrusted object. Fails closed on every defect.
    pub fn parse_untrusted(
        kind: &str,
        author: &[u8; 32],
        payload: &[u8],
        sig: &[u8; 64],
    ) -> Result<Self, ObjectError> {
        if !valid_kind(kind) {
            return Err(ObjectError::BadKind);
        }
        if payload.len() > MAX_OBJECT_BYTES {
            return Err(ObjectError::Oversized);
        }
        let key =
            VerifyingKey::from_bytes(author).map_err(|e| ObjectError::BadAuthor(e.to_string()))?;
        if key.is_weak() {
            return Err(ObjectError::BadAuthor("weak (small-order) key".into()));
        }
        let signature = Signature::from_bytes(sig);
        key.verify(&signing_bytes(author, kind, payload), &signature)
            .map_err(|e| ObjectError::BadSignature(e.to_string()))?;
        Ok(Self {
            kind: kind.to_string(),
            author: *author,
            payload: payload.to_vec(),
            sig: *sig,
            id: compute_id(author, kind, payload, sig),
        })
    }

    pub fn id_hex(&self) -> String {
        hex::encode(self.id)
    }

    /// Canonical JSON form (hex ids/keys, base64 payload).
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "v": 1,
            "kind": self.kind,
            "author": hex::encode(self.author),
            "payload": B64.encode(&self.payload),
            "sig": hex::encode(self.sig),
            "id": hex::encode(self.id),
        })
    }

    /// Parse JSON form, verifying signature AND id. Unknown kinds pass
    /// verification (storable) — rendering decisions belong to the caller.
    pub fn from_json(value: &serde_json::Value) -> Result<Self, ObjectError> {
        let kind = value
            .get("kind")
            .and_then(|k| k.as_str())
            .ok_or(ObjectError::BadKind)?;
        let author = decode_32(value.get("author").and_then(|a| a.as_str()).unwrap_or(""))
            .map_err(ObjectError::BadAuthor)?;
        let payload = value
            .get("payload")
            .and_then(|p| p.as_str())
            .ok_or_else(|| ObjectError::BadPayload("missing payload".into()))
            .and_then(|p| {
                B64.decode(p)
                    .map_err(|e| ObjectError::BadPayload(e.to_string()))
            })?;
        let sig = decode_64(value.get("sig").and_then(|s| s.as_str()).unwrap_or(""))
            .map_err(ObjectError::BadSignature)?;
        let obj = Self::parse_untrusted(kind, &author, &payload, &sig)?;
        let claimed = value.get("id").and_then(|i| i.as_str()).unwrap_or("");
        if hex::encode(obj.id) != claimed {
            return Err(ObjectError::BadId);
        }
        Ok(obj)
    }
}

fn decode_32(s: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(s.trim()).map_err(|e| format!("not hex: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("expected 32 bytes, got {}", bytes.len()));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn decode_64(s: &str) -> Result<[u8; 64], String> {
    let bytes = hex::decode(s.trim()).map_err(|e| format!("not hex: {e}"))?;
    if bytes.len() != 64 {
        return Err(format!("expected 64 bytes, got {}", bytes.len()));
    }
    let mut out = [0u8; 64];
    out.copy_from_slice(&bytes);
    Ok(out)
}
