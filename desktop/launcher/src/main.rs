//! nysiris desktop launcher (Linux).
//!
//! Serves the built PWA from `web/dist` over **loopback HTTP** and opens it in
//! a Chromium-based browser's `--app` window. Loopback is a secure context, and
//! the server sets the cross-origin-isolation headers (`COOP`/`COEP`) the Nym
//! WASM client may need for `SharedArrayBuffer`.
//!
//! Why system Chromium rather than a bundled webview:
//! * the Nym mixnet client is a Chromium-oriented WASM bundle, so Chromium is
//!   the compatibility target;
//! * WebKitGTK (Tauri/Wails on Linux) may lack required APIs — see
//!   `docs/07-desktop-linux.md`;
//! * it keeps the package small (no bundled browser).
//!
//! Only `127.0.0.1` is bound, and the file server refuses path traversal.

use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const DEFAULT_PORT: u16 = 0; // 0 = let the OS pick a free port
const MAX_HEADER_BYTES: usize = 16 * 1024;
const COOP: &str = "same-origin";
const COEP: &str = "require-corp";

struct Config {
    root: PathBuf,
    port: u16,
    open: bool,
    browser: Option<String>,
    /// Chrome/Chromium user-data-dir. A dedicated profile is important: it
    /// keeps the user's browser extensions (wallet injectors, content blockers)
    /// out of a privacy-sensitive app. Extensions can block same-origin
    /// subresources (`ERR_BLOCKED_BY_CLIENT`, which silently blanks the app)
    /// and inject `window.ethereum`/`window.web3` into every page.
    profile: PathBuf,
    /// Allow extensions in the app profile. Off by default.
    allow_extensions: bool,
}

fn main() {
    let config = match parse_args(env::args().skip(1)) {
        Ok(config) => config,
        Err(message) => {
            eprintln!("error: {message}");
            eprintln!();
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    };

    let root = match fs::canonicalize(&config.root) {
        Ok(root) => root,
        Err(err) => {
            eprintln!("error: cannot access web root {:?}: {err}", config.root);
            std::process::exit(1);
        }
    };
    if !root.join("index.html").is_file() {
        eprintln!(
            "error: {:?} does not contain index.html; build the web app first (./build.sh web)",
            root
        );
        std::process::exit(1);
    }

    let listener = match TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, config.port))) {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("error: cannot bind loopback port {}: {err}", config.port);
            std::process::exit(1);
        }
    };
    let port = listener
        .local_addr()
        .map(|a| a.port())
        .unwrap_or(config.port);
    let url = format!("http://127.0.0.1:{port}/");
    println!("nysiris serving {root:?}");
    println!("listening on {url}");

    if config.open {
        if let Err(err) = open_browser(
            config.browser.as_deref(),
            &url,
            &config.profile,
            config.allow_extensions,
        ) {
            eprintln!("warning: could not launch a browser automatically: {err}");
            eprintln!("open {url} manually");
        }
    }

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let root = root.clone();
                std::thread::spawn(move || {
                    if let Err(err) = handle_connection(stream, &root) {
                        eprintln!("connection error: {err}");
                    }
                });
            }
            Err(err) => eprintln!("accept error: {err}"),
        }
    }
}

const USAGE: &str = "\
Usage: nysiris-launcher [--root DIR] [--port N] [--browser CMD] [--no-open]

  --root DIR          directory containing the built web app (default: ./web/dist)
  --port N            loopback port to bind (default: 0 = choose a free port)
  --browser CMD       browser executable to prefer (default: auto-detect Chromium)
  --profile DIR        Chrome user-data-dir to use (default: a dedicated app profile)
  --allow-extensions   do NOT pass --disable-extensions (app profile keeps them out)
  --no-open           do not launch a browser (serve only; useful for tests)
  --help              show this help

The app runs in its own Chrome profile under
$XDG_DATA_HOME/nysiris/chrome-profile so your personal extensions do not
interfere with it.";

fn parse_args(args: impl Iterator<Item = String>) -> Result<Config, String> {
    let mut config = Config {
        root: PathBuf::from("web/dist"),
        port: DEFAULT_PORT,
        open: true,
        browser: None,
        profile: default_profile_dir(),
        allow_extensions: false,
    };

    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => {
                config.root = PathBuf::from(args.next().ok_or("--root needs a value")?);
            }
            "--port" => {
                config.port = args
                    .next()
                    .ok_or("--port needs a value")?
                    .parse()
                    .map_err(|e| format!("invalid --port: {e}"))?;
            }
            "--browser" => {
                config.browser = Some(args.next().ok_or("--browser needs a value")?);
            }
            "--profile" => {
                config.profile = PathBuf::from(args.next().ok_or("--profile needs a value")?);
            }
            "--allow-extensions" => config.allow_extensions = true,
            "--no-open" => config.open = false,
            "--help" | "-h" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            other if other.starts_with('-') => {
                return Err(format!("unknown argument: {other}"));
            }
            // Ignore positional arguments. Desktop launchers sometimes pass a
            // URL (`%u`) or file; there is no URL semantics for this app, and
            // erroring here would make the menu entry fail to start.
            _ => {}
        }
    }
    Ok(config)
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

fn handle_connection(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    let mut buffer = vec![0u8; MAX_HEADER_BYTES];
    let read = stream.read(&mut buffer)?;
    let request = &buffer[..read];
    let head = String::from_utf8_lossy(request);
    let request_line = head.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");

    if method != "GET" && method != "HEAD" {
        return write_response(&mut stream, 405, "text/plain", b"method not allowed", false);
    }

    let Some(relative) = sanitize_request_path(target) else {
        return write_response(&mut stream, 400, "text/plain", b"bad request", false);
    };

    let (status, mime, body, is_head) = match resolve_file(root, &relative) {
        Some(path) => {
            let bytes = fs::read(&path)?;
            (200u16, mime_for(&path), bytes, method == "HEAD")
        }
        None => {
            // SPA fallback: serve index.html for extension-less routes.
            let index = root.join("index.html");
            let bytes = fs::read(&index)?;
            (200u16, "text/html; charset=utf-8", bytes, method == "HEAD")
        }
    };

    write_response(&mut stream, status, mime, &body, is_head)
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    mime: &str,
    body: &[u8],
    head_only: bool,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {mime}\r\n\
         Content-Length: {}\r\n\
         Cross-Origin-Opener-Policy: {COOP}\r\n\
         Cross-Origin-Embedder-Policy: {COEP}\r\n\
         Cross-Origin-Resource-Policy: same-origin\r\n\
         X-Frame-Options: DENY\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes())?;
    if !head_only {
        stream.write_all(body)?;
    }
    stream.flush()
}

/// Resolve a request path to a file inside `root`, rejecting traversal.
///
/// Returns `None` when the path escapes the root or is not a regular file; the
/// caller then falls back to the SPA index.
fn resolve_file(root: &Path, relative: &str) -> Option<PathBuf> {
    let mut joined = root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => joined.push(part),
            Component::CurDir => {}
            // Any parent/root/prefix component escapes: refuse.
            _ => return None,
        }
    }
    if joined.is_dir() {
        joined.push("index.html");
    }
    if joined.is_file() {
        Some(joined)
    } else {
        None
    }
}

/// Normalise a raw request target into a safe relative path.
///
/// Returns `None` for anything suspicious (encoded traversal, absolute URLs,
/// backslashes). `%XX` sequences are decoded first so `%2e%2e` cannot slip
/// through.
fn sanitize_request_path(target: &str) -> Option<String> {
    let path = target.split(['?', '#']).next().unwrap_or("/");
    if path.contains('\\') {
        return None;
    }
    let decoded = percent_decode(path)?;
    if decoded.contains('\0') || decoded.contains('\\') {
        return None;
    }
    // Must be rooted and must not contain traversal after decoding.
    if !decoded.starts_with('/') {
        return None;
    }
    for segment in decoded.split('/') {
        if segment == ".." {
            return None;
        }
    }
    let trimmed = decoded.trim_start_matches('/');
    Some(if trimmed.is_empty() {
        "index.html".to_string()
    } else {
        trimmed.to_string()
    })
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex_val(bytes[i + 1])?;
            let lo = hex_val(bytes[i + 2])?;
            out.push(hi << 4 | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_val(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("wasm") => "application/wasm",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("map") => "application/json",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------------------
// Browser launching
// ---------------------------------------------------------------------------

fn open_browser(
    preferred: Option<&str>,
    url: &str,
    profile: &Path,
    allow_extensions: bool,
) -> Result<(), String> {
    let candidates: Vec<String> = if let Some(preferred) = preferred {
        vec![preferred.to_string()]
    } else {
        [
            "chromium",
            "chromium-browser",
            "google-chrome",
            "google-chrome-stable",
            "brave-browser",
            "microsoft-edge",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    };

    if let Err(err) = fs::create_dir_all(profile) {
        // Not fatal: Chrome will create it too. Windows/Flatpak sandboxes may
        // differ, so warn and continue.
        eprintln!("warning: could not create profile dir {profile:?}: {err}");
    }

    // Full install paths first on Windows (Edge/Chrome CLIs are rarely on
    // PATH); then the ordered PATH candidates on every platform.
    #[cfg(windows)]
    let mut found: Option<(PathBuf, bool)> = windows_install_candidates()
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| (p, false));
    #[cfg(not(windows))]
    let mut found: Option<(PathBuf, bool)> = None;
    if found.is_none() {
        for name in &candidates {
            if let Some(path) = find_in_path(name) {
                found = Some((path, name.contains("firefox")));
                break;
            }
        }
    }
    let (path, is_firefox) = match found {
        Some(found) => found,
        None => return fallback_opener(url),
    };

    let mut command = Command::new(&path);
    if is_firefox {
        // Firefox has no `--app` mode; open a plain window.
        command.arg("--new-window").arg(url);
    } else {
        // Chromium app window: no tabs, no URL bar.
        command.arg(format!("--app={url}"));
        command.arg(format!("--user-data-dir={}", profile.display()));
        command.arg("--no-first-run");
        command.arg("--no-default-browser-check");
        if !allow_extensions {
            // Extensions can block same-origin scripts or inject wallet
            // providers; keep them out of this profile.
            command.arg("--disable-extensions");
        }
    }
    command
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", path.display()))?;
    Ok(())
}

/// Last resort: hand off to the desktop's default handler.
#[cfg(windows)]
fn fallback_opener(url: &str) -> Result<(), String> {
    Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map_err(|e| format!("no Chromium browser found and start failed: {e}"))?;
    Ok(())
}

/// Last resort: hand off to the desktop's default handler.
#[cfg(not(windows))]
fn fallback_opener(url: &str) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|e| format!("no Chromium browser found and xdg-open failed: {e}"))?;
    Ok(())
}

/// Well-known Edge/Chrome install locations on Windows, Edge first (it ships
/// with the OS). Pure over its inputs so it stays unit-testable on any
/// platform; the `cfg(windows)` wrapper feeds it from the environment.
#[cfg(any(windows, test))]
fn windows_install_candidates_from(
    program_files: Option<&Path>,
    program_files_x86: Option<&Path>,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for base in [program_files, program_files_x86].into_iter().flatten() {
        out.push(
            base.join("Microsoft")
                .join("Edge")
                .join("Application")
                .join("msedge.exe"),
        );
        out.push(
            base.join("Google")
                .join("Chrome")
                .join("Application")
                .join("chrome.exe"),
        );
    }
    out
}

#[cfg(windows)]
fn windows_install_candidates() -> Vec<PathBuf> {
    let pf = env::var_os("PROGRAMFILES").map(PathBuf::from);
    let pf_x86 = env::var_os("ProgramFiles(x86)").map(PathBuf::from);
    windows_install_candidates_from(pf.as_deref(), pf_x86.as_deref())
}

/// Dedicated app profile: `%LOCALAPPDATA%\nysiris\chrome-profile` on
/// Windows; `$XDG_DATA_HOME/...` (or `$HOME/.local/share/...`) elsewhere.
fn default_profile_dir() -> PathBuf {
    #[cfg(windows)]
    if let Some(local) = env::var_os("LOCALAPPDATA").filter(|p| !p.is_empty()) {
        return PathBuf::from(local).join("nysiris").join("chrome-profile");
    }
    let base = env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from(".nysiris"));
    base.join("nysiris").join("chrome-profile")
}

#[cfg(unix)]
fn find_in_path(name: &str) -> Option<PathBuf> {
    if name.contains('/') {
        let path = PathBuf::from(name);
        return is_executable(&path).then_some(path);
    }
    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn find_in_path(name: &str) -> Option<PathBuf> {
    if name.contains('/') || name.contains('\\') {
        let path = PathBuf::from(name);
        return path.is_file().then_some(path);
    }
    // Probe PATH with and without `.exe`: MSYS2 shells resolve the suffix,
    // native CreateProcess does not. Split on both separators: native
    // Windows uses `;`, MSYS2/Cygwin shells pass `:`-separated PATH down.
    let path_var = env::var_os("PATH")?;
    let path_lossy = path_var.to_string_lossy();
    let dirs = env::split_paths(&path_var).chain(path_lossy.split([';', ':']).map(PathBuf::from));
    for dir in dirs {
        for candidate in [format!("{name}.exe"), name.to_string()] {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_types_are_mapped() {
        assert_eq!(
            mime_for(Path::new("a/index.html")),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            mime_for(Path::new("a/app.js")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            mime_for(Path::new("a/app.mjs")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(mime_for(Path::new("a/lib.wasm")), "application/wasm");
        assert_eq!(
            mime_for(Path::new("a/manifest.webmanifest")),
            "application/manifest+json"
        );
        assert_eq!(
            mime_for(Path::new("a/unknown.bin")),
            "application/octet-stream"
        );
    }

    #[test]
    fn sanitize_accepts_normal_paths() {
        assert_eq!(sanitize_request_path("/").as_deref(), Some("index.html"));
        assert_eq!(sanitize_request_path("/app.js").as_deref(), Some("app.js"));
        assert_eq!(
            sanitize_request_path("/a/b/c.css").as_deref(),
            Some("a/b/c.css")
        );
        assert_eq!(
            sanitize_request_path("/x?query=1#frag").as_deref(),
            Some("x")
        );
    }

    #[test]
    fn sanitize_rejects_traversal_and_absolute_urls() {
        assert!(sanitize_request_path("/../etc/passwd").is_none());
        assert!(sanitize_request_path("/%2e%2e/etc/passwd").is_none());
        assert!(sanitize_request_path("/a/../../b").is_none());
        assert!(sanitize_request_path("https://evil.example/").is_none());
        assert!(sanitize_request_path("/a\\b").is_none());
        assert!(sanitize_request_path("/%zz").is_none());
    }

    #[test]
    fn resolve_file_never_escapes_root() {
        let root = env::temp_dir().join("fly-launcher-test-root");
        let _ = fs::create_dir_all(root.join("sub"));
        let _ = fs::write(root.join("index.html"), b"<html>");
        let _ = fs::write(root.join("sub/a.js"), b"// a");
        let root = fs::canonicalize(&root).unwrap();

        assert!(resolve_file(&root, "index.html").is_some());
        assert!(resolve_file(&root, "sub/a.js").is_some());
        assert!(resolve_file(&root, "missing.js").is_none());
        // Attempts to escape yield None (caller falls back to index).
        assert!(resolve_file(&root, "../secret").is_none());
    }

    #[test]
    fn windows_candidates_prefer_edge_then_chrome_in_each_root() {
        let pf = Path::new("/pf");
        let x86 = Path::new("/x86");
        assert_eq!(
            windows_install_candidates_from(Some(pf), Some(x86)),
            vec![
                pf.join("Microsoft")
                    .join("Edge")
                    .join("Application")
                    .join("msedge.exe"),
                pf.join("Google")
                    .join("Chrome")
                    .join("Application")
                    .join("chrome.exe"),
                x86.join("Microsoft")
                    .join("Edge")
                    .join("Application")
                    .join("msedge.exe"),
                x86.join("Google")
                    .join("Chrome")
                    .join("Application")
                    .join("chrome.exe"),
            ]
        );
        assert_eq!(windows_install_candidates_from(Some(pf), None).len(), 2);
        assert!(windows_install_candidates_from(None, None).is_empty());
    }

    #[test]
    fn response_headers_include_cross_origin_isolation() {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            handle_connection(stream, &{
                let root = env::temp_dir().join("fly-launcher-headers");
                let _ = fs::create_dir_all(&root);
                let _ = fs::write(root.join("index.html"), b"<html>ok</html>");
                fs::canonicalize(&root).unwrap()
            })
            .unwrap();
        });
        let mut client = TcpStream::connect(addr).unwrap();
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        handle.join().unwrap();

        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("Cross-Origin-Opener-Policy: same-origin"));
        assert!(response.contains("Cross-Origin-Embedder-Policy: require-corp"));
        assert!(response.contains("X-Frame-Options: DENY"));
        assert!(response.contains("text/html"));
    }
}
