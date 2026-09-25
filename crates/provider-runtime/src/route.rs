//! Route plumbing shared by every nysiris provider: query parsing, JSON body
//! serialization, and fixed-width hex decode, plus a test envelope builder.
//! One copy with tests, instead of the same few functions in each service.
//!
//! `portal-data` keeps its own private `decode_32`/`decode_64` decoders: it is
//! a leaf data model and must not depend on this crate.

use std::collections::HashMap;

/// Split `/path?k=v&...` into (base, params). Last value wins; empty keys
/// are dropped; a missing `?` yields an empty map.
pub fn parse_query(path: &str) -> (String, HashMap<String, String>) {
    let (base, query) = match path.split_once('?') {
        Some((b, q)) => (b.to_string(), q),
        None => (path.to_string(), ""),
    };
    let mut params = HashMap::new();
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if !k.is_empty() {
                params.insert(k.to_string(), v.to_string());
            }
        }
    }
    (base, params)
}

/// Compact UTF-8 JSON body. Empty bytes only when serialization fails (e.g.
/// non-finite floats) — route bodies are never built that way.
pub fn json_body<T: serde::Serialize>(value: &T) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_default()
}

/// Decode exactly 32 bytes of hex ("author key", "object id"). Trims first.
pub fn hex32(s: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(s.trim()).map_err(|e| format!("not hex: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("expected 32 bytes, got {}", bytes.len()));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Decode exactly 64 bytes of hex (ed25519 signature).
pub fn hex64(s: &str) -> Result<[u8; 64], String> {
    let bytes = hex::decode(s.trim()).map_err(|e| format!("not hex: {e}"))?;
    if bytes.len() != 64 {
        return Err(format!("expected 64 bytes, got {}", bytes.len()));
    }
    let mut out = [0u8; 64];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// A hidden-service request envelope (the JSON packet the pwa's `rawSend`
/// produces). Used by service tests to drive [`HiddenService`] handlers; not
/// part of the route API itself.
///
/// [`HiddenService`]: nym_hidden_service::HiddenService
#[doc(hidden)]
pub fn envelope(method: &str, path: &str, body: &[u8]) -> Vec<u8> {
    let req = nym_hidden_service::Request::new(method, path, HashMap::new(), body)
        .expect("route test envelope is always well-formed");
    req.to_json().into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_query_splits_base_and_params() {
        let (base, params) = parse_query("/log/abc?since=3&x=1");
        assert_eq!(base, "/log/abc");
        assert_eq!(params.len(), 2);
        assert_eq!(params.get("since").map(String::as_str), Some("3"));
    }

    #[test]
    fn parse_query_without_query_has_no_params() {
        let (base, params) = parse_query("/heads");
        assert_eq!(base, "/heads");
        assert!(params.is_empty());
    }

    #[test]
    fn parse_query_drops_empty_keys_and_takes_last_value() {
        let (_, params) = parse_query("/x?=v&a=1&a=2");
        assert_eq!(params.len(), 1);
        assert_eq!(params.get("a").map(String::as_str), Some("2"));
    }

    #[test]
    fn json_body_round_trips_compact() {
        assert_eq!(
            json_body(&serde_json::json!({"a": 1})),
            br#"{"a":1}"#.to_vec()
        );
    }

    #[test]
    fn hex32_and_hex64_validate_lengths_and_hex() {
        let a = hex32("aabb".repeat(16).as_str()).unwrap();
        assert_eq!(a.to_vec(), [0xaau8, 0xbb].repeat(16));
        assert!(hex32("aabb").is_err());
        assert!(hex32("zz".repeat(32).as_str()).is_err());
        let s = hex64("99".repeat(64).as_str()).unwrap();
        assert_eq!(s, [0x99; 64]);
        assert!(hex64("99".repeat(32).as_str()).is_err());
    }

    #[test]
    fn envelope_round_trips_through_request_parse() {
        let raw = envelope("GET", "/heads", &[]);
        let req = nym_hidden_service::Request::from_json(&raw).unwrap();
        assert_eq!(req.method, "GET");
        assert_eq!(req.path, "/heads");
    }
}
