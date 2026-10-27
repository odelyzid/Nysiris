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
//! * a body over one mixnet message ([`MAX_ONE_PACKET_BODY`] bytes) is served
//!   as a sequence of `206 Partial Content` chunks with `Content-Range`; the
//!   browser's `fetchNymFull` reassembles them (`docs/08-hidden-services.md`
//!   §8.6).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use nym_hidden_service::{HiddenService, Request, Response};

/// Default index document served for a directory or `/`.
pub const DEFAULT_INDEX: &str = "index.html";

/// Largest raw body that still fits one hidden-service envelope in a single
/// Sphinx message (base64 + JSON overhead included). Larger files are served
/// in `Content-Range` chunks of at most this size.
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
        let total = metadata.len() as usize;
        let requested = match request.headers.get("range") {
            Some(raw) => match parse_range(raw, total) {
                Some(range) => Some(range),
                None => return Response::error(416, "invalid Range header"),
            },
            None => None,
        };

        if request.method == "HEAD" {
            let mut response = Response::ok(200, content_type_for(&file), &[]);
            response
                .headers
                .insert("content-length".to_string(), total.to_string());
            response
                .headers
                .insert("accept-ranges".to_string(), "bytes".to_string());
            response
                .headers
                .insert("x-nysiris-total-length".to_string(), total.to_string());
            if let Some((start, end)) = requested {
                response.status = 206;
                response.headers.insert(
                    "content-range".to_string(),
                    format!("bytes {start}-{end}/{total}"),
                );
                response
                    .headers
                    .insert("content-length".to_string(), (end - start + 1).to_string());
            }
            return response;
        }

        let chunk_size = self.max_bytes.max(1);
        let (start, end, status) = match requested {
            Some((start, end)) => {
                let capped_end = end.min(start + chunk_size - 1);
                (start, capped_end, 206)
            }
            None if total > chunk_size => (0, chunk_size - 1, 206),
            None => (0, total.saturating_sub(1), 200),
        };
        let length = if total == 0 { 0 } else { end - start + 1 };
        let body = match read_slice(&file, start, length) {
            Ok(body) => body,
            Err(err) => return Response::error(500, format!("read failed: {err}")),
        };

        let mut response = Response::ok(status, content_type_for(&file), &body);
        response
            .headers
            .insert("content-length".to_string(), body.len().to_string());
        response
            .headers
            .insert("accept-ranges".to_string(), "bytes".to_string());
        response
            .headers
            .insert("x-nysiris-total-length".to_string(), total.to_string());
        if status == 206 {
            response.headers.insert(
                "content-range".to_string(),
                format!("bytes {start}-{end}/{total}"),
            );
        }
        response
    }
}

/// Parse one `bytes=start-end`, `bytes=start-`, or suffix range.
///
/// Returns inclusive `(start, end)` clamped to the file; multi-range requests
/// are rejected because the service answers with one chunk at a time.
fn parse_range(raw: &str, total: usize) -> Option<(usize, usize)> {
    let rest = raw.trim().strip_prefix("bytes=")?;
    if rest.contains(',') || total == 0 {
        return None;
    }
    let (start_raw, end_raw) = rest.split_once('-')?;
    if start_raw.is_empty() {
        let suffix = end_raw.trim().parse::<usize>().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = total.saturating_sub(suffix);
        return Some((start, total - 1));
    }
    let start = start_raw.trim().parse::<usize>().ok()?;
    if start >= total {
        return None;
    }
    let end = if end_raw.trim().is_empty() {
        total - 1
    } else {
        end_raw.trim().parse::<usize>().ok()?.min(total - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn read_slice(file: &Path, start: usize, length: usize) -> std::io::Result<Vec<u8>> {
    let mut handle = File::open(file)?;
    handle.seek(SeekFrom::Start(start as u64))?;
    let mut body = vec![0u8; length];
    handle.read_exact(&mut body)?;
    Ok(body)
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
    fn oversized_body_is_served_in_ranges() {
        let root = temp_root("oversize");
        let root_path = root.clone();
        let bytes: Vec<u8> = (0..(MAX_ONE_PACKET_BODY + 1))
            .map(|i| (i % 251) as u8)
            .collect();
        std::fs::write(root.join("big.html"), &bytes).unwrap();
        let service = StaticFiles::new(&root).unwrap();

        let first = service.handle(&request("GET", "/big.html"));
        assert_eq!(first.status, 206);
        assert_eq!(
            first.headers.get("content-range"),
            Some(&format!(
                "bytes 0-{}/{}",
                MAX_ONE_PACKET_BODY - 1,
                bytes.len()
            ))
        );
        assert_eq!(first.body().unwrap().len(), MAX_ONE_PACKET_BODY);

        let mut ranged = request("GET", "/big.html");
        ranged
            .headers
            .insert("range".to_string(), format!("bytes={MAX_ONE_PACKET_BODY}-"));
        let second = service.handle(&ranged);
        assert_eq!(second.status, 206);
        assert_eq!(second.body().unwrap(), &bytes[MAX_ONE_PACKET_BODY..]);
        let _ = std::fs::remove_dir_all(&root_path);
    }

    #[test]
    fn head_advertises_ranges_and_invalid_ranges_are_416() {
        let root = temp_root("range-head");
        std::fs::write(root.join("big.html"), vec![b'x'; 5000]).unwrap();
        let service = StaticFiles::new(&root).unwrap();

        let head = service.handle(&request("HEAD", "/big.html"));
        assert_eq!(head.status, 200);
        assert_eq!(
            head.headers.get("accept-ranges").map(String::as_str),
            Some("bytes")
        );
        assert_eq!(
            head.headers
                .get("x-nysiris-total-length")
                .map(String::as_str),
            Some("5000")
        );
        assert!(head.body().unwrap().is_empty());

        let mut bad = request("GET", "/big.html");
        bad.headers
            .insert("range".to_string(), "bytes=9999-".to_string());
        assert_eq!(service.handle(&bad).status, 416);
        let _ = std::fs::remove_dir_all(&root);
    }
}
