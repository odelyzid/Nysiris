//! A traversal-safe static-file hidden service: `nysiris host files`.
//!
//! Serves a local directory as `GET`/`HEAD` responses over the hidden-service
//! envelope. This is deliberately conservative:
//!
//! * the request path is **never** percent-decoded, so encoding tricks cannot
//!   escape the root (the `bridge-guard` path rules already reject `..`,
//!   `%2e`, `%2f`, `%5c`, backslashes and protocol-relative paths; this module
//!   adds a second, filesystem-level containment check);
//! * the resolved target is canonicalised and must stay inside the canonical
//!   root, which also defeats symlink escapes;
//! * only `GET`/`HEAD` are answered; anything else is `405`;
//! * bodies are capped at one mixnet message ([`MAX_ONE_PACKET_BODY`] bytes of
//!   raw body). Larger files return `413` until chunked transfer is wired
//!   (`docs/08-hidden-services.md` §8.6).

use std::path::{Path, PathBuf};

use nym_hidden_service::{HiddenService, Request, Response};

/// Default index document served for a directory or `/`.
pub const DEFAULT_INDEX: &str = "index.html";

/// Largest raw body that still fits one hidden-service envelope in a single
/// Sphinx message (base64 + JSON overhead included). Larger files need
/// chunking, which the messaging shape does not support yet.
pub const MAX_ONE_PACKET_BODY: usize = 1400;

/// A directory served as a hidden service.
#[derive(Debug, Clone)]
pub struct StaticFiles {
    root: PathBuf,
    index: String,
    max_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileError {
    NotFound,
    Forbidden,
}

impl StaticFiles {
    /// Serve `root` with [`DEFAULT_INDEX`] and [`MAX_ONE_PACKET_BODY`].
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, String> {
        Self::with_options(root, DEFAULT_INDEX, MAX_ONE_PACKET_BODY)
    }

    /// Serve `root`, using `index` for directories and refusing bodies over
    /// `max_bytes`.
    pub fn with_options(
        root: impl Into<PathBuf>,
        index: impl Into<String>,
        max_bytes: usize,
    ) -> Result<Self, String> {
        let root = root.into();
        let root = std::fs::canonicalize(&root)
            .map_err(|e| format!("web root {} is not usable: {e}", root.display()))?;
        if !root.is_dir() {
            return Err(format!("web root {} is not a directory", root.display()));
        }
        Ok(Self {
            root,
            index: index.into(),
            max_bytes,
        })
    }

    /// The canonicalised directory being served.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Maximum body size this service will return.
    pub fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    /// Map a request path to an on-disk file inside the root, or explain why
    /// not. Never follows a path out of the root.
    fn resolve(&self, request_path: &str) -> Result<PathBuf, FileError> {
        // Query strings are not part of the filesystem path; strip before use.
        let path = request_path.split('?').next().unwrap_or(request_path);
        let relative = path.trim_start_matches('/');
        let relative = relative.strip_suffix('/').unwrap_or(relative);

        let mut candidate = self.root.clone();
        if relative.is_empty() {
            candidate.push(&self.index);
        } else {
            for segment in relative.split('/') {
                if segment.is_empty() || segment == "." || segment == ".." {
                    return Err(FileError::Forbidden);
                }
                candidate.push(segment);
            }
        }

        let real = std::fs::canonicalize(&candidate).map_err(|_| FileError::NotFound)?;
        if !real.starts_with(&self.root) {
            return Err(FileError::Forbidden);
        }
        if real.is_dir() {
            let index =
                std::fs::canonicalize(real.join(&self.index)).map_err(|_| FileError::NotFound)?;
            if !index.starts_with(&self.root) {
                return Err(FileError::Forbidden);
            }
            return Ok(index);
        }
        Ok(real)
    }

    fn respond(&self, request: &Request, file: PathBuf) -> Response {
        let metadata = match std::fs::metadata(&file) {
            Ok(metadata) => metadata,
            Err(_) => return Response::error(404, "not found"),
        };
        if metadata.len() as usize > self.max_bytes {
            return Response::error(
                413,
                format!(
                    "file is {} bytes; one mixnet message carries at most {} (chunking is not supported yet)",
                    metadata.len(),
                    self.max_bytes
                ),
            );
        }
        let body = if request.method == "HEAD" {
            Vec::new()
        } else {
            match std::fs::read(&file) {
                Ok(bytes) => bytes,
                Err(err) => return Response::error(500, format!("read failed: {err}")),
            }
        };
        let mut response = Response::ok(200, content_type_for(&file), &body);
        response
            .headers
            .insert("content-length".to_string(), metadata.len().to_string());
        response
    }
}

impl HiddenService for StaticFiles {
    fn handle(&self, request: &Request) -> Response {
        match request.method.as_str() {
            "GET" | "HEAD" => {}
            _ => return Response::error(405, "only GET and HEAD are served"),
        }
        match self.resolve(&request.path) {
            Ok(file) => self.respond(request, file),
            Err(FileError::NotFound) => Response::error(404, "not found"),
            Err(FileError::Forbidden) => Response::error(403, "forbidden"),
        }
    }
}

/// Content type by extension, defaulting to `application/octet-stream`.
pub fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("wasm") => "application/wasm",
        Some("pdf") => "application/pdf",
        Some("xml") => "application/xml",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nysiris-sdk-files-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn request(method: &str, path: &str) -> Request {
        Request {
            method: method.to_string(),
            path: path.to_string(),
            headers: HashMap::new(),
            body_base64: String::new(),
            tag: None,
        }
    }

    #[test]
    fn serves_directory_index() {
        let root = temp_root("index");
        std::fs::write(root.join("index.html"), b"<h1>hi</h1>").unwrap();
        let service = StaticFiles::new(&root).unwrap();

        let response = service.handle(&request("GET", "/"));
        assert_eq!(response.status, 200);
        assert_eq!(response.body().unwrap(), b"<h1>hi</h1>");
        assert_eq!(
            response.headers.get("content-type").map(String::as_str),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(
            response.headers.get("content-length").map(String::as_str),
            Some("11")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn head_returns_headers_without_body() {
        let root = temp_root("head");
        std::fs::write(root.join("index.html"), b"hello").unwrap();
        let service = StaticFiles::new(&root).unwrap();

        let response = service.handle(&request("HEAD", "/index.html"));
        assert_eq!(response.status, 200);
        assert!(response.body().unwrap().is_empty());
        assert_eq!(
            response.headers.get("content-length").map(String::as_str),
            Some("5")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn maps_extensions_and_missing_files() {
        let root = temp_root("types");
        std::fs::write(root.join("data.bin"), b"\x00\x01").unwrap();
        let service = StaticFiles::new(&root).unwrap();

        let bin = service.handle(&request("GET", "/data.bin"));
        assert_eq!(
            bin.headers.get("content-type").map(String::as_str),
            Some("application/octet-stream")
        );
        assert_eq!(service.handle(&request("GET", "/nope.html")).status, 404);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_methods_other_than_get_and_head() {
        let root = temp_root("method");
        let service = StaticFiles::new(&root).unwrap();
        assert_eq!(service.handle(&request("POST", "/")).status, 405);
        assert_eq!(service.handle(&request("DELETE", "/")).status, 405);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_traversal_even_though_the_envelope_guard_runs_first() {
        let root = temp_root("traversal");
        std::fs::write(root.join("index.html"), b"safe").unwrap();
        // A secret one level above the root must never be readable.
        std::fs::write(root.parent().unwrap().join("secret.txt"), b"top secret").unwrap();
        let service = StaticFiles::new(&root).unwrap();

        assert_eq!(
            service.handle(&request("GET", "/../secret.txt")).status,
            403
        );
        assert_eq!(service.handle(&request("GET", "/a//b")).status, 403);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn oversized_body_is_413() {
        let root = temp_root("oversize");
        std::fs::write(root.join("big.html"), vec![b'x'; MAX_ONE_PACKET_BODY + 1]).unwrap();
        let service = StaticFiles::new(&root).unwrap();

        let response = service.handle(&request("GET", "/big.html"));
        assert_eq!(response.status, 413);
        assert!(response.error.unwrap().contains("chunking"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
