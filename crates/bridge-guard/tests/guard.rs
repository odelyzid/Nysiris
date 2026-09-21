//! Tests for the bridge open-proxy guards (`docs/05-security.md` §5.10).

use bridge_guard::{
    validate, GuardError, RequestSpec, ALLOWED_METHODS, DEFAULT_MAX_BODY_BYTES,
    FORWARDED_REQUEST_HEADERS,
};

fn spec<'a>(method: &'a str, path: &'a str, headers: &'a [(&'a str, &'a str)]) -> RequestSpec<'a> {
    RequestSpec::new(method, path, 0, headers)
}

#[test]
fn accepts_a_normal_rooted_request() {
    let headers = [("Content-Type", "application/json"), ("Accept", "*/*")];
    let validated = validate(spec("get", "/api/status", &headers), DEFAULT_MAX_BODY_BYTES)
        .expect("valid request");
    assert_eq!(validated.method, "GET");
    assert_eq!(validated.path, "/api/status");
    assert_eq!(
        validated.forwarded_headers,
        vec![
            ("content-type".to_string(), "application/json".to_string()),
            ("accept".to_string(), "*/*".to_string()),
        ]
    );
}

#[test]
fn rejects_methods_outside_the_allow_list() {
    for method in ["TRACE", "CONNECT", "OPTIONS", "get; rm -rf /"] {
        let err = validate(spec(method, "/", &[]), DEFAULT_MAX_BODY_BYTES).unwrap_err();
        assert!(
            matches!(err, GuardError::MethodNotAllowed(_)),
            "method {method} must be rejected, got {err:?}"
        );
    }
    // Every documented method is accepted.
    for method in ALLOWED_METHODS {
        validate(spec(method, "/", &[]), DEFAULT_MAX_BODY_BYTES).expect("allowed method");
    }
}

#[test]
fn rejects_absolute_urls_and_protocol_relative_paths() {
    assert!(matches!(
        validate(
            spec("GET", "https://evil.example/", &[]),
            DEFAULT_MAX_BODY_BYTES
        )
        .unwrap_err(),
        GuardError::PathNotRooted(_)
    ));
    assert!(matches!(
        validate(spec("GET", "//evil.example/", &[]), DEFAULT_MAX_BODY_BYTES).unwrap_err(),
        GuardError::PathProtocolRelative
    ));
}

#[test]
fn rejects_traversal_raw_and_encoded() {
    for path in [
        "/../etc/passwd",
        "/a/../../b",
        "/%2e%2e/etc",
        "/%2fetc",
        "/x%5c..%5cy",
    ] {
        let err = validate(spec("GET", path, &[]), DEFAULT_MAX_BODY_BYTES).unwrap_err();
        assert!(
            matches!(
                err,
                GuardError::PathTraversal(_) | GuardError::PathContainsBackslash
            ),
            "path {path} must be rejected, got {err:?}"
        );
    }
    assert!(matches!(
        validate(spec("GET", "/a\\b", &[]), DEFAULT_MAX_BODY_BYTES).unwrap_err(),
        GuardError::PathContainsBackslash
    ));
}

#[test]
fn rejects_empty_and_unrooted_paths() {
    assert!(matches!(
        validate(spec("GET", "", &[]), DEFAULT_MAX_BODY_BYTES).unwrap_err(),
        GuardError::EmptyPath
    ));
    assert!(matches!(
        validate(spec("GET", "relative", &[]), DEFAULT_MAX_BODY_BYTES).unwrap_err(),
        GuardError::PathNotRooted(_)
    ));
}

#[test]
fn enforces_the_body_cap() {
    let ok = RequestSpec::new("POST", "/", DEFAULT_MAX_BODY_BYTES, &[]);
    validate(ok, DEFAULT_MAX_BODY_BYTES).expect("at the cap");

    let too_big = RequestSpec::new("POST", "/", DEFAULT_MAX_BODY_BYTES + 1, &[]);
    assert!(matches!(
        validate(too_big, DEFAULT_MAX_BODY_BYTES).unwrap_err(),
        GuardError::BodyTooLarge { .. }
    ));
}

#[test]
fn drops_sensitive_headers() {
    let headers = [
        ("Authorization", "Bearer secret"),
        ("Cookie", "session=abc"),
        ("Host", "evil.example"),
        ("Content-Type", "text/plain"),
    ];
    let validated = validate(spec("GET", "/x", &headers), DEFAULT_MAX_BODY_BYTES).unwrap();
    let names: Vec<&str> = validated
        .forwarded_headers
        .iter()
        .map(|(n, _)| n.as_str())
        .collect();
    assert_eq!(names, vec!["content-type"]);
    assert_eq!(FORWARDED_REQUEST_HEADERS.len(), 2);
}

#[test]
fn caps_are_explicit() {
    assert_eq!(DEFAULT_MAX_BODY_BYTES, 64 * 1024);
    assert!(!ALLOWED_METHODS.contains(&"CONNECT"));
}
