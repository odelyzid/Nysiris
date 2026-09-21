//! HTTP-like request/response envelopes carried as opaque message bytes.
//!
//! The backend stays Nym-unaware: it sees an ordinary method + path + headers +
//! body, and returns status + headers + body. Bodies travel base64-encoded so
//! the envelope is always valid JSON/UTF-8, matching what the TypeScript client
//! (`web/src/mixnet/hiddenService.ts`) and the Rust bridge exchange.
//!
//! Every request constructed here passes through `bridge-guard` validation, so
//! the open-proxy guards (`docs/05-security.md` §5.10) hold for any service
//! built on this crate.

use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use bridge_guard::{validate, GuardError, RequestSpec, ValidatedRequest};
use serde::{Deserialize, Serialize};

/// Default body cap, mirroring the bridge.
pub use bridge_guard::DEFAULT_MAX_BODY_BYTES;

/// A request to a hidden service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Raw body, base64-encoded.
    #[serde(default)]
    pub body_base64: String,
}

/// A reply from a hidden service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Response {
    pub status: u16,
    pub headers: HashMap<String, String>,
    /// Raw body, base64-encoded.
    pub body_base64: String,
    pub error: Option<String>,
}

impl Request {
    /// Build a request, enforcing the open-proxy guards up front.
    pub fn new(
        method: &str,
        path: &str,
        headers: HashMap<String, String>,
        body: &[u8],
    ) -> Result<Self, GuardError> {
        let header_refs: Vec<(&str, &str)> = headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let validated: ValidatedRequest = validate(
            RequestSpec::new(method, path, body.len(), &header_refs),
            DEFAULT_MAX_BODY_BYTES,
        )?;
        Ok(Self {
            method: validated.method,
            path: validated.path,
            headers: validated
                .forwarded_headers
                .into_iter()
                .collect::<HashMap<_, _>>(),
            body_base64: B64.encode(body),
        })
    }

    /// Decode the body bytes.
    pub fn body(&self) -> Result<Vec<u8>, String> {
        B64.decode(&self.body_base64)
            .map_err(|e| format!("body_base64 invalid: {e}"))
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn from_json(raw: &[u8]) -> Result<Self, String> {
        serde_json::from_slice(raw).map_err(|e| format!("bad request envelope: {e}"))
    }
}

impl Response {
    pub fn ok(status: u16, content_type: &str, body: &[u8]) -> Self {
        let mut headers = HashMap::new();
        headers.insert("content-type".to_string(), content_type.to_string());
        Self {
            status,
            headers,
            body_base64: B64.encode(body),
            error: None,
        }
    }

    pub fn error(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            headers: HashMap::new(),
            body_base64: String::new(),
            error: Some(message.into()),
        }
    }

    /// Decode the body bytes.
    pub fn body(&self) -> Result<Vec<u8>, String> {
        if self.body_base64.is_empty() {
            return Ok(Vec::new());
        }
        B64.decode(&self.body_base64)
            .map_err(|e| format!("body_base64 invalid: {e}"))
    }

    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    pub fn from_json(raw: &[u8]) -> Result<Self, String> {
        serde_json::from_slice(raw).map_err(|e| format!("bad response envelope: {e}"))
    }
}
