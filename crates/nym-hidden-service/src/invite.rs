//! Invite links: signed introductions to a hidden service.
//!
//! An invite binds a service address to an introducer:
//!
//! ```text
//! signed_bytes = b"fly-portal-v1/invite" || svc_identity(32) || svc_encryption(32)
//!                || svc_gateway(32) || inviter(32) || note
//! link         = "nym://<id>.<enc>@<gw>#invite=<base64url(JSON)>"
//! ```
//!
//! The fragment never goes on the wire — it authenticates *to the recipient*
//! who invited them, client-side. Verification checks the inner service
//! address matches the link address (no bait-and-switch), then the signature.
//! Notes are capped so invites stay well under one packet.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::uri::{NymUri, UriError};

pub const INVITE_DOMAIN: &[u8] = b"fly-portal-v1/invite";
pub const MAX_NOTE_LEN: usize = 140;

/// A signed introduction. JSON-serializable for the compact link form.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Invite {
    pub service: String,
    pub inviter: String,
    pub note: String,
    pub sig: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InviteError {
    BadService(UriError),
    BadKey(String),
    BadSig(String),
    BadNote,
    ServiceMismatch,
    BadSignature(String),
    BadEncoding(String),
}

impl std::fmt::Display for InviteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InviteError::BadService(e) => write!(f, "bad service address: {e}"),
            InviteError::BadKey(e) => write!(f, "bad inviter key: {e}"),
            InviteError::BadSig(e) => write!(f, "bad signature: {e}"),
            InviteError::BadNote => write!(f, "note must be 1-140 chars"),
            InviteError::ServiceMismatch => {
                write!(f, "invite names a different service than the link")
            }
            InviteError::BadSignature(e) => write!(f, "bad invite signature: {e}"),
            InviteError::BadEncoding(e) => write!(f, "bad invite encoding: {e}"),
        }
    }
}

impl std::error::Error for InviteError {}

pub fn signing_bytes(service: &NymUri, inviter: &[u8; 32], note: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(INVITE_DOMAIN.len() + 32 * 4 + note.len());
    out.extend_from_slice(INVITE_DOMAIN);
    out.extend_from_slice(&service.identity);
    out.extend_from_slice(&service.encryption);
    out.extend_from_slice(&service.gateway);
    out.extend_from_slice(inviter);
    out.extend_from_slice(note.as_bytes());
    out
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

fn check_note(note: &str) -> Result<(), InviteError> {
    if note.is_empty() || note.chars().count() > MAX_NOTE_LEN {
        return Err(InviteError::BadNote);
    }
    Ok(())
}

impl Invite {
    /// Build an invite (caller's keypair signs; browser mirrors this layout).
    pub fn sign_new(
        signing_key: &ed25519_dalek::SigningKey,
        service: &NymUri,
        note: &str,
    ) -> Result<Self, InviteError> {
        use ed25519_dalek::Signer;
        check_note(note)?;
        let inviter = signing_key.verifying_key().to_bytes();
        let sig = signing_key
            .sign(&signing_bytes(service, &inviter, note))
            .to_bytes();
        Ok(Self {
            service: service.to_uri(),
            inviter: hex::encode(inviter),
            note: note.to_string(),
            sig: hex::encode(sig),
        })
    }

    /// Verify against the address of the link carrying it.
    pub fn verify_against(&self, link_service: &NymUri) -> Result<(), InviteError> {
        check_note(&self.note)?;
        let service = NymUri::parse(&self.service).map_err(InviteError::BadService)?;
        if service != *link_service {
            return Err(InviteError::ServiceMismatch);
        }
        let inviter = decode_32(&self.inviter).map_err(InviteError::BadKey)?;
        let sig = decode_64(&self.sig).map_err(InviteError::BadSig)?;
        let key =
            VerifyingKey::from_bytes(&inviter).map_err(|e| InviteError::BadKey(e.to_string()))?;
        if key.is_weak() {
            return Err(InviteError::BadKey("weak (small-order) key".into()));
        }
        key.verify(
            &signing_bytes(&service, &inviter, &self.note),
            &Signature::from_bytes(&sig),
        )
        .map_err(|e| InviteError::BadSignature(e.to_string()))
    }

    /// Compact link-fragment form.
    pub fn encode_compact(&self) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).unwrap_or_default())
    }

    pub fn decode_compact(compact: &str) -> Result<Self, InviteError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(compact.trim())
            .map_err(|e| InviteError::BadEncoding(e.to_string()))?;
        serde_json::from_slice(&bytes).map_err(|e| InviteError::BadEncoding(e.to_string()))
    }

    /// Full link: `nym://<addr>#invite=<compact>`.
    pub fn to_link(&self, service: &NymUri) -> String {
        format!("{}#invite={}", service.to_uri(), self.encode_compact())
    }
}
