//! Server harness: parse, validate, handle, serialize.
//!
//! A hidden service implements [`HiddenService::handle`] — pure application
//! logic over [`Request`] / [`Response`]. [`dispatch`] wires it to the wire:
//! it parses the inbound bytes, re-validates through `bridge-guard` (defence
//! in depth: the client side validated too), calls the handler, and returns
//! the serialized reply bytes ready for `send_reply`.
//!
//! The transport loop itself (wait/reply, SURBs, budgets) stays in the service
//! crates; this module owns everything that can be unit-tested without the
//! network.

use crate::envelope::{Request, Response};

/// Application logic of one hidden service.
pub trait HiddenService {
    /// Handle a validated request. The request has already passed the
    /// open-proxy guards; enforce any additional per-service allow-lists here.
    fn handle(&self, request: &Request) -> Response;
}

/// Parse + validate + handle + serialize one inbound message.
///
/// Never panics on untrusted input: malformed envelopes become 400/502-style
/// [`Response::error`] payloads, never a crash.
pub fn dispatch(service: &impl HiddenService, raw: &[u8]) -> Vec<u8> {
    let request = match Request::from_json(raw) {
        Ok(request) => request,
        Err(message) => return Response::error(400, message).to_json(),
    };

    // Re-validate server-side even though Request::new validated client-side:
    // the bytes on the wire are untrusted.
    let header_refs: Vec<(&str, &str)> = request
        .headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let body_len = request.body().map(|b| b.len()).unwrap_or(usize::MAX);
    if bridge_guard::validate(
        bridge_guard::RequestSpec::new(&request.method, &request.path, body_len, &header_refs),
        bridge_guard::DEFAULT_MAX_BODY_BYTES,
    )
    .is_err()
    {
        return Response::error(400, "request rejected by open-proxy guards").to_json();
    }

    service.handle(&request).with_tag(&request.tag).to_json()
}

/// A trivial echo service, useful for tests and as a template.
pub struct EchoService;

impl HiddenService for EchoService {
    fn handle(&self, request: &Request) -> Response {
        let body = request.body().unwrap_or_default();
        let text = String::from_utf8_lossy(&body);
        Response::ok(
            200,
            "text/plain",
            format!("echo [{} {}]: {text}", request.method, request.path).as_bytes(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn dispatch_echoes_the_correlation_tag() {
        let mut req = Request::new("GET", "/", HashMap::new(), b"hi").unwrap();
        req.tag = Some("part-3-of-6".into());
        let rep = Response::from_json(&dispatch(&EchoService, req.to_json().as_bytes())).unwrap();
        assert_eq!(rep.tag.as_deref(), Some("part-3-of-6"));
    }

    #[test]
    fn legacy_envelopes_without_tags_still_work() {
        // No tag anywhere: None in, None out — old clients and old
        // services interoperate unchanged.
        let req = Request::new("GET", "/", HashMap::new(), b"hi").unwrap();
        assert_eq!(req.tag, None);
        let rep = Response::from_json(&dispatch(&EchoService, req.to_json().as_bytes())).unwrap();
        assert_eq!(rep.tag, None);
        // Unknown fields (e.g. a tag from a newer client) are ignored on parse.
        let raw = br#"{"method":"GET","path":"/","tag":"new","mystery":42}"#;
        let parsed = Request::from_json(raw).unwrap();
        assert_eq!(parsed.tag.as_deref(), Some("new"));
    }
}
