//! Hidden-service routes for fly-social.
//!
//! Transport envelope: [`nym_hidden_service`] `Request`/`Response` JSON.
//! Service API bodies are JSON; every write carries an ed25519 signature
//! verified here before anything touches SQLite (see `sig.rs`).
//!
//! ```text
//! GET  /health                  -> {ok, seq}
//! GET  /feed?since=<seq>&limit=<n>  -> {posts:[...], next}
//! POST /post   {author,day,body,in_reply_to?,sig} -> {seq,id}
//! GET  /post/<hex32>              -> one post (for filling thread gaps)
//! GET  /profile/<hex64>                     -> {author,name,bio,day}
//! POST /profile {author,name,bio,day,sig}   -> {ok}
//! POST /dm     {to,nonce,ciphertext}        -> {id}   (opaque, E2E)
//! GET  /dm?for=<hex64>                      -> {dms:[...]} (destructive read)
//! ```
//!
//! Replies are plain posts with `in_reply_to` set to the parent post's id.
//! The service verifies the signature covers the parent and that the parent
//! exists — then stores the field opaquely. Thread assembly is entirely the
//! client's job (see `web/src/social/threads.ts`).

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine as _;
use nym_hidden_service::{HiddenService, Request, Response};

use crate::sig;
use crate::store::Store;

pub struct SocialService {
    store: Mutex<Store>,
    rate: Mutex<portal_reputation::rate::RateLimiter>,
    pow_bits: u32,
}

impl SocialService {
    pub fn new(store: Store) -> Self {
        Self::with_limits(store, 0, portal_reputation::rate::RatePolicy::default())
    }

    /// `pow_bits`: required PoW difficulty, advertised in `GET /` (0 = off).
    /// `policy`: per-author daily write budget (DMs bucketed per recipient).
    pub fn with_limits(
        store: Store,
        pow_bits: u32,
        policy: portal_reputation::rate::RatePolicy,
    ) -> Self {
        Self {
            store: Mutex::new(store),
            rate: Mutex::new(portal_reputation::rate::RateLimiter::new(policy)),
            pow_bits: pow_bits.min(portal_reputation::pow::MAX_POW_BITS),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Store>, Response> {
        self.store
            .lock()
            .map_err(|_| Response::error(500, "store busy"))
    }

    fn today() -> u64 {
        sig::current_day()
    }

    fn check_rate(&self, bucket: &str) -> Result<(), Response> {
        let mut rate = self
            .rate
            .lock()
            .map_err(|_| Response::error(500, "store busy"))?;
        if rate.try_spend(bucket, Self::today()) {
            Ok(())
        } else {
            Err(Response::error(429, "rate budget exhausted for today"))
        }
    }

    /// PoW binds (key, payload_hash): posts/profiles bind the author's key,
    /// DMs bind the recipient's key (senders stay anonymous).
    fn check_pow(
        &self,
        key: &[u8; 32],
        payload_hash: &[u8; 32],
        v: &serde_json::Value,
    ) -> Result<(), Response> {
        if self.pow_bits == 0 {
            return Ok(());
        }
        let pow = v
            .get("pow")
            .ok_or_else(|| Response::error(400, "proof-of-work required"))?;
        let nonce = pow
            .get("nonce")
            .and_then(|n| n.as_u64())
            .ok_or_else(|| Response::error(400, "bad pow nonce"))?;
        let bits = pow
            .get("bits")
            .and_then(|b| b.as_u64())
            .ok_or_else(|| Response::error(400, "bad pow bits"))? as u32;
        if bits < self.pow_bits {
            return Err(Response::error(400, "proof-of-work below required difficulty"));
        }
        let proof = portal_reputation::pow::Proof { nonce, bits };
        if !portal_reputation::pow::verify(key, payload_hash, &proof) {
            return Err(Response::error(400, "invalid proof-of-work"));
        }
        Ok(())
    }
}

fn parse_query(path: &str) -> (String, HashMap<String, String>) {
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

fn json_body<T: serde::Serialize>(value: &T) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_default()
}

/// Machine-readable service descriptor (see `DESCRIPTOR_HTML` for humans).
/// Advertises `pow_bits` so clients prove exactly the required difficulty.
fn descriptor_json(pow_bits: u32) -> serde_json::Value {
    serde_json::json!({
        "service": "fly-social",
        "version": "0.1.0",
        "pow_bits": pow_bits,
        "routes": [
            "GET /health",
            "GET /feed?since=<seq>&limit=<n>",
            "POST /post",
            "GET /post/<hex32>",
            "GET /profile/<hex64>",
            "POST /profile",
            "POST /dm",
            "GET /dm?for=<hex64>",
        ],
    })
}

const DESCRIPTOR_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<meta name=\"color-scheme\" content=\"light dark\">\
<title>fly-social</title>\
<style>body{font-family:system-ui,-apple-system,\"Segoe UI\",sans-serif;\
max-width:44rem;margin:2rem auto;padding:0 1rem;line-height:1.6}\
h1,h2{line-height:1.2}code{background:rgba(127,127,127,.15);\
padding:.1em .35em;border-radius:.3em}li{margin:.25em 0}</style></head><body>\
<h1>fly-social</h1>\
<p>Metadata-minimal microblog + encrypted DMs, reachable only over the Nym mixnet.</p>\
<h2>Timeline</h2>\
<ul>\
<li><code>GET /feed?since=&lt;seq&gt;&amp;limit=&lt;n&gt;</code> — global chronological timeline</li>\
<li><code>POST /post</code> — signed micro-post (max 1400 bytes; optional <code>in_reply_to</code> parent id)</li>\
<li><code>GET /post/&lt;id&gt;</code> — one post by id, for filling thread gaps</li>\
<li><code>GET /profile/&lt;pubkey&gt;</code> / <code>POST /profile</code> — self-asserted profiles</li>\
</ul>\
<h2>Private messages</h2>\
<ul>\
<li><code>POST /dm</code> / <code>GET /dm?for=&lt;pubkey&gt;</code> — sealed direct messages, self-destruct on read</li>\
</ul>\
<p>No accounts, no follows, no likes, no read receipts. Your public key is your name.</p>\
</body></html>";

impl HiddenService for SocialService {
    fn handle(&self, request: &Request) -> Response {
        let body = match request.body() {
            Ok(b) => b,
            Err(e) => return Response::error(400, e),
        };
        let (route, query) = parse_query(&request.path);
        match (request.method.as_str(), route.as_str()) {
            ("GET", "/") => {
                // Content negotiation: browsers ask for HTML (the URI bar sends
                // `Accept: text/html`), API clients get JSON. The bridge
                // forwards `accept` (allow-listed), so this is reliable.
                let wants_html = request
                    .headers
                    .get("accept")
                    .map(|a| a.contains("text/html"))
                    .unwrap_or(false);
                if wants_html {
                    Response::ok(200, "text/html", DESCRIPTOR_HTML.as_bytes())
                } else {
                    Response::ok(200, "application/json", &json_body(&descriptor_json(self.pow_bits)))
                }
            }
            ("GET", "/health") => {
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.latest_seq() {
                    Ok(seq) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({"ok": true, "seq": seq})),
                    ),
                    Err(e) => Response::error(500, e),
                }
            }
            ("GET", "/feed") => {
                let since = query
                    .get("since")
                    .and_then(|v| v.parse::<i64>().ok())
                    .unwrap_or(0)
                    .max(0);
                let limit = query
                    .get("limit")
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(20);
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.feed(since, limit) {
                    Ok((posts, next)) => {
                        let items: Vec<_> = posts
                            .iter()
                            .map(|p| {
                                serde_json::json!({
                                    "seq": p.seq, "id": p.id_hex, "author": p.author_hex,
                                    "day": p.day, "body": p.body,
                                    "in_reply_to": p.in_reply_to_hex,
                                    "sig": p.sig_hex,
                                })
                            })
                            .collect();
                        Response::ok(
                            200,
                            "application/json",
                            &json_body(&serde_json::json!({"posts": items, "next": next})),
                        )
                    }
                    Err(e) => Response::error(500, e),
                }
            }
            ("POST", "/post") => {
                let v: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => return Response::error(400, "post body must be JSON"),
                };
                let author = match v.get("author").and_then(|a| a.as_str()).map(sig::parse_pubkey) {
                    Some(Ok(a)) => a,
                    _ => return Response::error(400, "bad author"),
                };
                let sig = match v.get("sig").and_then(|s| s.as_str()).map(sig::parse_sig) {
                    Some(Ok(s)) => s,
                    _ => return Response::error(400, "bad sig"),
                };
                let day = v.get("day").and_then(|d| d.as_u64()).unwrap_or(0);
                // Day-freshness: bound the replay window to ±2 days. Coarse days
                // stay private; stale signatures are simply re-signed client-side.
                if day.abs_diff(sig::current_day()) > 2 {
                    return Response::error(400, "stale day: re-sign with the current UTC day");
                }
                let text = v.get("body").and_then(|b| b.as_str()).unwrap_or("");
                if text.as_bytes().len() > crate::store::MAX_POST_BYTES {
                    return Response::error(400, "post too long (max 1400 bytes)");
                }
                // Optional reply parent: 16 raw bytes as 32 hex chars, naming
                // an existing post. The service checks existence (a store
                // lookup, not thread assembly) and verifies the signature
                // covers the parent — then stores it opaquely.
                let parent: Option<[u8; 16]> = match v.get("in_reply_to") {
                    None => None,
                    Some(s) => {
                        let s = match s.as_str() {
                            Some(s) => s,
                            None => return Response::error(400, "in_reply_to must be a hex string"),
                        };
                        let bytes = match hex::decode(s.trim()) {
                            Ok(b) => b,
                            Err(_) => return Response::error(400, "in_reply_to must be hex"),
                        };
                        if bytes.len() != 16 {
                            return Response::error(400, "in_reply_to must be a 16-byte post id");
                        }
                        let mut id = [0u8; 16];
                        id.copy_from_slice(&bytes);
                        Some(id)
                    }
                };
                if sig::verify(
                    &author,
                    &sig::post_message(&author, day, text.as_bytes(), parent.as_ref()),
                    &sig,
                )
                .is_err()
                {
                    return Response::error(400, "signature verification failed");
                }
                // Spam backstops: PoW binds (author, parent, body) so a proof
                // for a top-level post can't be replayed onto a reply and
                // vice versa; budget is per author.
                let mut pow_preimage = Vec::with_capacity(16 + text.len());
                if let Some(p) = parent.as_ref() {
                    pow_preimage.extend_from_slice(p);
                }
                pow_preimage.extend_from_slice(text.as_bytes());
                let pow_hash = portal_reputation::pow::payload_hash(&pow_preimage);
                if let Err(e) = self.check_pow(&author, &pow_hash, &v) {
                    return e;
                }
                if let Err(e) = self.check_rate(&hex::encode(author)) {
                    return e;
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                if let Some(p) = parent.as_ref() {
                    match store.get_post_by_id(p) {
                        Ok(Some(_)) => {}
                        Ok(None) => return Response::error(400, "unknown parent post"),
                        Err(e) => return Response::error(500, e),
                    }
                }
                let sig_bytes = sig.to_bytes();
                match store.insert_post(&author, day, text, parent.as_ref(), &sig_bytes, rand::random()) {
                    Ok(seq) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({"seq": seq})),
                    ),
                    Err(e) => Response::error(500, e),
                }
            }
            ("GET", p) if p.starts_with("/post/") => {
                // Single-post lookup so clients can fill missing thread
                // ancestors. Same item shape as the feed.
                let hex = &p["/post/".len()..];
                let id = match hex::decode(hex.trim()) {
                    Ok(b) if b.len() == 16 => b,
                    _ => return Response::error(400, "post id must be a 16-byte hex string"),
                };
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.get_post_by_id(&id) {
                    Ok(Some(post)) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({
                            "seq": post.seq, "id": post.id_hex, "author": post.author_hex,
                            "day": post.day, "body": post.body,
                            "in_reply_to": post.in_reply_to_hex,
                            "sig": post.sig_hex,
                        })),
                    ),
                    Ok(None) => Response::error(404, "no such post"),
                    Err(e) => Response::error(500, e),
                }
            }
            ("GET", p) if p.starts_with("/profile/") => {
                let hex = &p["/profile/".len()..];
                let author = match sig::parse_pubkey(hex) {
                    Ok(a) => a,
                    Err(e) => return Response::error(400, e),
                };
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.get_profile(&author) {
                    Ok(Some(p)) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({
                            "author": p.author_hex, "name": p.name,
                            "bio": p.bio, "day": p.day,
                        })),
                    ),
                    Ok(None) => Response::error(404, "no such profile"),
                    Err(e) => Response::error(500, e),
                }
            }
            ("POST", "/profile") => {
                let v: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => return Response::error(400, "profile body must be JSON"),
                };
                let author = match v.get("author").and_then(|a| a.as_str()).map(sig::parse_pubkey) {
                    Some(Ok(a)) => a,
                    _ => return Response::error(400, "bad author"),
                };
                let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let bio = v.get("bio").and_then(|b| b.as_str()).unwrap_or("");
                let day = v.get("day").and_then(|d| d.as_u64()).unwrap_or(0);
                if day.abs_diff(sig::current_day()) > 2 {
                    return Response::error(400, "stale day: re-sign with the current UTC day");
                }
                let sig = match v.get("sig").and_then(|s| s.as_str()).map(sig::parse_sig) {
                    Some(Ok(s)) => s,
                    _ => return Response::error(400, "bad sig"),
                };
                if sig::verify(&author, &sig::profile_message(&author, name, bio), &sig).is_err() {
                    return Response::error(400, "signature verification failed");
                }
                let mut payload_preimage = Vec::with_capacity(name.len() + 1 + bio.len());
                payload_preimage.extend_from_slice(name.as_bytes());
                payload_preimage.push(0x00);
                payload_preimage.extend_from_slice(bio.as_bytes());
                let pow_hash = portal_reputation::pow::payload_hash(&payload_preimage);
                if let Err(e) = self.check_pow(&author, &pow_hash, &v) {
                    return e;
                }
                if let Err(e) = self.check_rate(&hex::encode(author)) {
                    return e;
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let sig_bytes = sig.to_bytes();
                match store.upsert_profile(&author, name, bio, day, &sig_bytes) {
                    Ok(()) => Response::ok(200, "application/json", b"{\"ok\":true}"),
                    Err(e) => Response::error(400, e),
                }
            }
            ("POST", "/dm") => {
                let v: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => return Response::error(400, "dm body must be JSON"),
                };
                let to = match v.get("to").and_then(|t| t.as_str()).map(sig::parse_pubkey) {
                    Some(Ok(t)) => t,
                    _ => return Response::error(400, "bad recipient"),
                };
                let nonce = match v.get("nonce").and_then(|n| n.as_str()).and_then(|n| hex::decode(n).ok()) {
                    Some(n) if n.len() == 24 => n,
                    _ => return Response::error(400, "nonce must be 24 bytes hex"),
                };
                let epub = match v.get("epub").and_then(|e| e.as_str()).and_then(|e| hex::decode(e).ok()) {
                    Some(e) if e.len() == 32 => e,
                    _ => return Response::error(400, "epub must be 32 bytes hex"),
                };
                let ct = match v
                    .get("ciphertext")
                    .and_then(|c| c.as_str())
                    .and_then(|c| base64_decode(c))
                {
                    Some(ct) if !ct.is_empty() => ct,
                    _ => return Response::error(400, "bad ciphertext"),
                };
                let mut nonce_arr = [0u8; 24];
                nonce_arr.copy_from_slice(&nonce);
                let mut epub_arr = [0u8; 32];
                epub_arr.copy_from_slice(&epub);
                // DMs stay sender-anonymous: PoW binds the *recipient* key and
                // the ciphertext, and the budget buckets per recipient (this
                // caps mailbox flooding against one victim).
                let pow_hash = portal_reputation::pow::payload_hash(&ct);
                if let Err(e) = self.check_pow(&to, &pow_hash, &v) {
                    return e;
                }
                if let Err(e) = self.check_rate(&format!("dm:{}", hex::encode(to))) {
                    return e;
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.store_dm(&to, &epub_arr, &nonce_arr, &ct) {
                    Ok(id) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({"id": id})),
                    ),
                    Err(e) => Response::error(400, e),
                }
            }
            ("GET", "/dm") => {
                let who = match query.get("for").map(|f| sig::parse_pubkey(f)) {
                    Some(Ok(w)) => w,
                    _ => return Response::error(400, "missing ?for=<pubkey>"),
                };
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.fetch_dms(&who) {
                    Ok(dms) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({"dms": items_map(&dms)})),
                    ),
                    Err(e) => Response::error(500, e),
                }
            }
            _ => Response::error(404, "unknown route"),
        }
    }
}

fn items_map(dms: &[crate::store::DirectMessage]) -> Vec<serde_json::Value> {
    dms.iter()
        .map(|d| {
            serde_json::json!({
                "id": d.id, "epub": d.epub_hex, "nonce": d.nonce_hex,
                "ciphertext": d.ciphertext_b64,
            })
        })
        .collect()
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use nym_hidden_service::dispatch;
    use std::collections::HashMap;

    fn test_service() -> SocialService {
        SocialService::new(Store::open_in_memory().unwrap())
    }

    fn signed_post(sk: &SigningKey, day: u64, body: &str) -> serde_json::Value {
        signed_reply(sk, day, body, None)
    }

    fn signed_reply(
        sk: &SigningKey,
        day: u64,
        body: &str,
        parent: Option<[u8; 16]>,
    ) -> serde_json::Value {
        let author = sk.verifying_key().to_bytes();
        let msg = sig::post_message(&author, day, body.as_bytes(), parent.as_ref());
        let sig = sk.sign(&msg);
        let mut v = serde_json::json!({
            "author": hex::encode(author),
            "day": day,
            "body": body,
            "sig": hex::encode(sig.to_bytes()),
        });
        if let Some(p) = parent {
            v["in_reply_to"] = serde_json::json!(hex::encode(p));
        }
        v
    }

    fn envelope(method: &str, path: &str, body: &[u8]) -> Vec<u8> {
        let req = nym_hidden_service::Request::new(method, path, HashMap::new(), body).unwrap();
        req.to_json().into_bytes()
    }

    fn pow_for_post(author: &[u8; 32], body: &str, bits: u32) -> serde_json::Value {
        pow_for_reply(author, body, None, bits)
    }

    /// PoW preimage mirrors the service: parent bytes (if any) + body.
    fn pow_for_reply(
        author: &[u8; 32],
        body: &str,
        parent: Option<[u8; 16]>,
        bits: u32,
    ) -> serde_json::Value {
        let mut preimage = Vec::with_capacity(16 + body.len());
        if let Some(p) = parent {
            preimage.extend_from_slice(&p);
        }
        preimage.extend_from_slice(body.as_bytes());
        let hash = portal_reputation::pow::payload_hash(&preimage);
        let proof =
            portal_reputation::pow::prove(author, &hash, bits, 0, 10_000_000).expect("low-bit proof");
        serde_json::json!({"nonce": proof.nonce, "bits": proof.bits})
    }

    #[test]
    fn pow_and_rate_gate_post_writes() {
        use portal_reputation::rate::RatePolicy;

        let svc = SocialService::with_limits(
            Store::open_in_memory().unwrap(),
            4,
            RatePolicy { max_per_day: 1 },
        );
        let sk = SigningKey::from_bytes(&[8u8; 32]);
        let author = sk.verifying_key().to_bytes();
        let day = sig::current_day();

        // Missing proof refused when required.
        let bare = signed_post(&sk, day, "no pow");
        let raw = envelope("POST", "/post", bare.to_string().as_bytes());
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 400);

        // Valid proof accepted, spending the single daily budget...
        let mut good = signed_post(&sk, day, "with pow");
        good["pow"] = pow_for_post(&author, "with pow", 4);
        let raw = envelope("POST", "/post", good.to_string().as_bytes());
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 200);

        // ...and the next write hits 429.
        let mut second = signed_post(&sk, day, "second");
        second["pow"] = pow_for_post(&author, "second", 4);
        let raw = envelope("POST", "/post", second.to_string().as_bytes());
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 429);
    }

    #[test]
    fn root_describes_the_service() {
        let svc = test_service();
        // Default: machine-readable JSON.
        let raw = envelope("GET", "/", &[]);
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        assert_eq!(rep.status, 200);
        let body: serde_json::Value = serde_json::from_slice(&rep.body().unwrap()).unwrap();
        assert_eq!(body["service"], "fly-social");

        // Browsers send Accept: text/html and get a renderable page.
        let mut headers = HashMap::new();
        headers.insert("accept".to_string(), "text/html".to_string());
        let req = nym_hidden_service::Request::new("GET", "/", headers, &[]).unwrap();
        let rep = Response::from_json(&dispatch(&svc, req.to_json().as_bytes())).unwrap();
        assert_eq!(rep.status, 200);
        let text = String::from_utf8(rep.body().unwrap()).unwrap();
        assert!(text.contains("<h1>fly-social</h1>"));
        // Sections mirror the client's community tabs (Timeline / Private
        // messages); the route list is the contract both sides share.
        assert!(text.contains("<h2>Timeline</h2>"));
        assert!(text.contains("<h2>Private messages</h2>"));
        assert!(text.contains("GET /feed?since="));
        assert!(text.contains("POST /post"));
        assert!(text.contains("POST /dm"));
        assert!(text.contains("/post/&lt;id&gt;"));
    }

    #[test]
    fn post_verify_store_and_feed() {
        let svc = test_service();
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let author_hex = hex::encode(sk.verifying_key().to_bytes());

        // Unsigned/tampered post is refused.
        let day = sig::current_day();
        let mut bad = signed_post(&sk, day, "hello");
        bad["body"] = serde_json::json!("forged");
        let raw = envelope("POST", "/post", bad.to_string().as_bytes());
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        assert_eq!(rep.status, 400);

        // Signed post lands in the feed.
        let good = signed_post(&sk, day, "hello");
        let raw = envelope("POST", "/post", good.to_string().as_bytes());
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        assert_eq!(rep.status, 200);

        let raw = envelope("GET", "/feed?since=0&limit=20", &[]);
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        let body: serde_json::Value = serde_json::from_slice(&rep.body().unwrap()).unwrap();
        assert_eq!(body["posts"].as_array().unwrap().len(), 1);
        assert_eq!(body["posts"][0]["author"], author_hex);
        // Top-level posts carry an explicit null parent.
        assert_eq!(body["posts"][0]["in_reply_to"], serde_json::Value::Null);
    }

    #[test]
    fn reply_thread_round_trip_through_store_only() {
        let svc = test_service();
        let day = sig::current_day();
        let alice = SigningKey::from_bytes(&[21u8; 32]);
        let bob = SigningKey::from_bytes(&[22u8; 32]);

        // Root post lands; feed names its id.
        let raw = envelope("POST", "/post", signed_post(&alice, day, "root").to_string().as_bytes());
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 200);
        let raw = envelope("GET", "/feed?since=0&limit=20", &[]);
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        let feed: serde_json::Value = serde_json::from_slice(&rep.body().unwrap()).unwrap();
        let root_id = feed["posts"][0]["id"].as_str().unwrap().to_string();

        // A reply naming the root is stored with its parent attached.
        let mut parent = [0u8; 16];
        parent.copy_from_slice(&hex::decode(&root_id).unwrap());
        let raw = envelope(
            "POST",
            "/post",
            signed_reply(&bob, day, "reply", Some(parent)).to_string().as_bytes(),
        );
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 200);

        // Feed serves the link verbatim; single-post lookup resolves it.
        let raw = envelope("GET", "/feed?since=0&limit=20", &[]);
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        let feed: serde_json::Value = serde_json::from_slice(&rep.body().unwrap()).unwrap();
        assert_eq!(feed["posts"].as_array().unwrap().len(), 2);
        assert_eq!(feed["posts"][1]["in_reply_to"], root_id);
        let raw = envelope("GET", &format!("/post/{root_id}"), &[]);
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        assert_eq!(rep.status, 200);
        let one: serde_json::Value = serde_json::from_slice(&rep.body().unwrap()).unwrap();
        assert_eq!(one["body"], "root");

        // Unknown post id: 404, not a crash.
        let raw = envelope("GET", &format!("/post/{}", "ff".repeat(16)), &[]);
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 404);
    }

    #[test]
    fn replies_reject_bad_or_unknown_parents() {
        let svc = test_service();
        let day = sig::current_day();
        let sk = SigningKey::from_bytes(&[23u8; 32]);

        // Malformed parent id.
        let mut bad_hex = signed_post(&sk, day, "x");
        bad_hex["in_reply_to"] = serde_json::json!("zz");
        // Re-sign over the claimed parent so only the shape check can fail…
        // (shape is checked after JSON parse but the sig won't match either;
        // both paths must 400, never store).
        let raw = envelope("POST", "/post", bad_hex.to_string().as_bytes());
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 400);

        // Well-formed signature, but the parent doesn't exist.
        let ghost = [9u8; 16];
        let raw = envelope(
            "POST",
            "/post",
            signed_reply(&sk, day, "orphan", Some(ghost)).to_string().as_bytes(),
        );
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        assert_eq!(rep.status, 400);

        // Nothing was stored.
        let raw = envelope("GET", "/feed?since=0&limit=20", &[]);
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        let feed: serde_json::Value = serde_json::from_slice(&rep.body().unwrap()).unwrap();
        assert!(feed["posts"].as_array().unwrap().is_empty());
    }

    #[test]
    fn profile_and_dm_round_trip() {
        let svc = test_service();
        let sk = SigningKey::from_bytes(&[3u8; 32]);
        let author = sk.verifying_key().to_bytes();
        let msg = sig::profile_message(&author, "ada", "bio");
        let sig = sk.sign(&msg);
        let body = serde_json::json!({
            "author": hex::encode(author), "name": "ada", "bio": "bio",
            "day": sig::current_day(), "sig": hex::encode(sig.to_bytes()),
        });
        let raw = envelope("POST", "/profile", body.to_string().as_bytes());
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 200);

        let raw = envelope("GET", &format!("/profile/{}", hex::encode(author)), &[]);
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        assert_eq!(rep.status, 200);

        // Opaque DM in, same bytes out, then gone.
        let ct = base64::engine::general_purpose::STANDARD.encode(b"secret-bytes");
        let dm = serde_json::json!({
            "to": hex::encode(author),
            "epub": hex::encode([5u8; 32]),
            "nonce": hex::encode([4u8; 24]),
            "ciphertext": ct,
        });
        let raw = envelope("POST", "/dm", dm.to_string().as_bytes());
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 200);
        let raw = envelope("GET", &format!("/dm?for={}", hex::encode(author)), &[]);
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        let body: serde_json::Value = serde_json::from_slice(&rep.body().unwrap()).unwrap();
        assert_eq!(body["dms"].as_array().unwrap().len(), 1);
        assert_eq!(body["dms"][0]["ciphertext"], ct);
        let raw = envelope("GET", &format!("/dm?for={}", hex::encode(author)), &[]);
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        let body: serde_json::Value = serde_json::from_slice(&rep.body().unwrap()).unwrap();
        assert!(body["dms"].as_array().unwrap().is_empty());
    }
}
