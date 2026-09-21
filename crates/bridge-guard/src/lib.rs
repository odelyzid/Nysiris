//! Open-proxy guards for the hybrid mixnet↔HTTP bridge.
//!
//! These are the §5.10 controls from `docs/05-security.md`, made testable:
//! a mixnet request must not be able to turn the bridge into an open proxy.
//! The bridge deserialises an envelope, then calls [`validate`] before touching
//! the backend. Keeping the rules here (dependency-free) means they run in the
//! fast workspace test loop, not only in the nym-sdk build.
//!
//! Enforced rules:
//! * **Method allow-list** — only idempotent/expected verbs.
//! * **Rooted, non-traversing path** — no absolute URLs, no `..`, no `//`,
//!   no percent-encoded traversal, no backslashes.
//! * **Bounded body** — a request cannot exceed the configured cap.
//! * **Header allow-list** — only `content-type` and `accept` reach the backend.

#![forbid(unsafe_code)]

/// HTTP methods a mixnet request may use.
pub const ALLOWED_METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/// Default cap on request body size. Well above one Sphinx packet (the mixnet
/// chunks larger bodies) but bounded to protect the backend.
pub const DEFAULT_MAX_BODY_BYTES: usize = 64 * 1024;

/// Request headers forwarded to the backend. Everything else is dropped,
/// notably `authorization`, `cookie`, and `host`.
pub const FORWARDED_REQUEST_HEADERS: &[&str] = &["content-type", "accept"];

/// A request as parsed from the mixnet envelope, before validation.
#[derive(Debug, Clone, Copy)]
pub struct RequestSpec<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub body_len: usize,
    pub headers: &'a [(&'a str, &'a str)],
}

impl<'a> RequestSpec<'a> {
    pub fn new(
        method: &'a str,
        path: &'a str,
        body_len: usize,
        headers: &'a [(&'a str, &'a str)],
    ) -> Self {
        Self {
            method,
            path,
            body_len,
            headers,
        }
    }
}

/// A request that passed every guard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedRequest {
    /// Upper-cased method.
    pub method: String,
    /// The rooted path, safe to append to the backend base URL.
    pub path: String,
    /// Only the allow-listed headers, lower-cased.
    pub forwarded_headers: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardError {
    /// §5.10 — method not in [`ALLOWED_METHODS`].
    MethodNotAllowed(String),
    /// §5.10 — path must start with `/`.
    PathNotRooted(String),
    /// §5.10 — `..` traversal (raw or percent-encoded).
    PathTraversal(String),
    /// §5.10 — protocol-relative (`//host`) or absolute URL smuggling.
    PathProtocolRelative,
    /// §5.10 — backslashes are treated as separators by some stacks.
    PathContainsBackslash,
    /// §5.10 — empty path.
    EmptyPath,
    /// §5.10 — body exceeds the cap.
    BodyTooLarge { len: usize, max: usize },
}

impl std::fmt::Display for GuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GuardError::MethodNotAllowed(m) => write!(f, "method `{m}` is not allowed"),
            GuardError::PathNotRooted(p) => write!(f, "path must be rooted, got `{p}`"),
            GuardError::PathTraversal(p) => write!(f, "path traversal is not allowed: `{p}`"),
            GuardError::PathProtocolRelative => {
                write!(f, "protocol-relative paths (`//host`) are not allowed")
            }
            GuardError::PathContainsBackslash => write!(f, "backslashes are not allowed in paths"),
            GuardError::EmptyPath => write!(f, "path must not be empty"),
            GuardError::BodyTooLarge { len, max } => {
                write!(f, "body too large: {len} bytes exceeds {max}")
            }
        }
    }
}

impl std::error::Error for GuardError {}

/// Validate a mixnet request against every open-proxy guard.
pub fn validate(
    spec: RequestSpec<'_>,
    max_body_bytes: usize,
) -> Result<ValidatedRequest, GuardError> {
    let method = spec.method.trim().to_ascii_uppercase();
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(GuardError::MethodNotAllowed(spec.method.to_string()));
    }

    let path = spec.path.trim();
    if path.is_empty() {
        return Err(GuardError::EmptyPath);
    }
    if !path.starts_with('/') {
        return Err(GuardError::PathNotRooted(path.to_string()));
    }
    if path.starts_with("//") {
        return Err(GuardError::PathProtocolRelative);
    }
    if path.contains('\\') {
        return Err(GuardError::PathContainsBackslash);
    }

    // Raw traversal, and percent-encoded variants (`%2e%2e`, `%2f`, `%5c`).
    let lowered = path.to_ascii_lowercase();
    if lowered.contains("..")
        || lowered.contains("%2e")
        || lowered.contains("%2f")
        || lowered.contains("%5c")
    {
        return Err(GuardError::PathTraversal(path.to_string()));
    }

    if spec.body_len > max_body_bytes {
        return Err(GuardError::BodyTooLarge {
            len: spec.body_len,
            max: max_body_bytes,
        });
    }

    let mut forwarded_headers = Vec::new();
    for (name, value) in spec.headers {
        let lower = name.to_ascii_lowercase();
        if FORWARDED_REQUEST_HEADERS.contains(&lower.as_str()) {
            forwarded_headers.push((lower, value.to_string()));
        }
    }

    Ok(ValidatedRequest {
        method,
        path: path.to_string(),
        forwarded_headers,
    })
}
