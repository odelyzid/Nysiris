//! Portal routes: object + log storage, verification only.
//!
//! ```text
//! GET  /                              descriptor
//! POST /obj        {object json}       -> {id, stored}
//! GET  /obj/<idhex>                    -> {object json}
//! POST /log-entry  {author,seq,obj_id,sig} -> {seq}
//! GET  /log/<authorhex>?since=<n>      -> {entries:[...], head}
//! GET  /heads                          -> {heads:[{author,seq}]}
//! ```
//!
//! Every write is verified before storage. Reads re-verify. Unknown object
//! kinds store fine (bytes are bytes) — rendering stays client-side.

use std::sync::Mutex;

use nym_hidden_service::{HiddenService, Request, Response};
use portal_data::{LogEntry, Object};
use provider_runtime::route::{hex32, hex64, json_body, parse_query};
use provider_runtime::Router;

use crate::store::Store;

pub struct PortalService {
    store: Mutex<Store>,
    router: Router,
}

impl PortalService {
    /// `pow_bits`: required PoW difficulty (0 = off). `max_per_day`: per-author
    /// daily write budget (backstop when PoW pricing is wrong).
    pub fn with_limits(
        store: Store,
        pow_bits: u32,
        policy: portal_reputation::rate::RatePolicy,
    ) -> Self {
        Self {
            store: Mutex::new(store),
            router: Router::new(pow_bits, policy),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Store>, Response> {
        self.store
            .lock()
            .map_err(|_| Response::error(500, "store busy"))
    }

    /// Rate check keyed by author hex. 429 on exhaustion.
    fn gate_rate(&self, author_hex: &str) -> Result<(), Response> {
        self.router
            .rate
            .check(author_hex)
            .map_err(|msg| Response::error(429, msg))
    }

    /// PoW check. The proof binds (author, object id) — it cannot be replayed
    /// for another object or author. Skipped entirely when `pow_bits` is 0.
    fn gate_pow(&self, author: &[u8; 32], obj_id: &[u8; 32], v: &serde_json::Value) -> Result<(), Response> {
        self.router
            .pow
            .verify_json(author, obj_id, v)
            .map_err(|msg| Response::error(400, msg))
    }
}

const DESCRIPTOR_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<meta name=\"color-scheme\" content=\"light dark\">\
<title>portal</title>\
<style>body{font-family:system-ui,-apple-system,\"Segoe UI\",sans-serif;\
max-width:44rem;margin:2rem auto;padding:0 1rem;line-height:1.6}\
h1,h2{line-height:1.2}code{background:rgba(127,127,127,.15);\
padding:.1em .35em;border-radius:.3em}li{margin:.25em 0}</style></head><body>\
<h1>portal provider</h1>\
<p>Content-addressed object + log storage. Data and signature verification only.</p>\
<ul>\
<li><code>POST /obj</code> — store a signed object</li>\
<li><code>GET /obj/&lt;id&gt;</code> — fetch by content id</li>\
<li><code>POST /log-entry</code> — append to an author's log</li>\
<li><code>GET /log/&lt;author&gt;?since=&lt;n&gt;</code> — read a log range</li>\
<li><code>GET /heads</code> — all author heads for sync</li>\
</ul>\
</body></html>";

impl HiddenService for PortalService {
    fn handle(&self, request: &Request) -> Response {
        let body = match request.body() {
            Ok(b) => b,
            Err(e) => return Response::error(400, e),
        };
        let (route, query) = parse_query(&request.path);
        match (request.method.as_str(), route.as_str()) {
            ("GET", "/") => {
                let wants_html = request
                    .headers
                    .get("accept")
                    .map(|a| a.contains("text/html"))
                    .unwrap_or(false);
                if wants_html {
                    Response::ok(200, "text/html", DESCRIPTOR_HTML.as_bytes())
                } else {
                    Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({
                            "service": "portal-provider",
                            "version": "0.1.0",
                            "pow_bits": self.router.pow.bits(),
                            "routes": ["GET /heads", "GET /obj/<id>", "GET /log/<author>?since=<n>",
                                       "POST /obj", "POST /log-entry"],
                        })),
                    )
                }
            }
            ("POST", "/obj") => {
                let v: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => return Response::error(400, "object body must be JSON"),
                };
                let obj = match Object::from_json(&v) {
                    Ok(obj) => obj,
                    Err(e) => return Response::error(400, e.to_string()),
                };
                if let Err(e) = self.gate_pow(&obj.author, &obj.id, &v) {
                    return e;
                }
                if let Err(e) = self.gate_rate(&hex::encode(obj.author)) {
                    return e;
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.put_object(&obj) {
                    Ok(stored) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({"id": obj.id_hex(), "stored": stored})),
                    ),
                    Err(e) => Response::error(500, e),
                }
            }
            ("GET", p) if p.starts_with("/obj/") => {
                let id = match hex32(&p["/obj/".len()..]) {
                    Ok(id) => id,
                    Err(e) => return Response::error(400, e),
                };
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.get_object(&id) {
                    Ok(Some(obj)) => Response::ok(200, "application/json", &json_body(&obj.to_json())),
                    Ok(None) => Response::error(404, "no such object"),
                    Err(e) => Response::error(500, e),
                }
            }
            ("POST", "/log-entry") => {
                let v: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => return Response::error(400, "log-entry body must be JSON"),
                };
                let get = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("");
                let author = match hex32(get("author")) {
                    Ok(a) => a,
                    Err(e) => return Response::error(400, e),
                };
                let seq = match v.get("seq").and_then(|s| s.as_u64()) {
                    Some(s) => s,
                    None => return Response::error(400, "missing seq"),
                };
                let obj_id = match hex32(get("obj_id")) {
                    Ok(o) => o,
                    Err(e) => return Response::error(400, e),
                };
                let sig = match hex64(get("sig")) {
                    Ok(s) => s,
                    Err(e) => return Response::error(400, e),
                };
                // PoW binds the full entry bytes (author + seq + object).
                let entry_hash =
                    portal_reputation::pow::payload_hash(&portal_data::log::entry_bytes(
                        &author, seq, &obj_id,
                    ));
                if let Err(e) = self.gate_pow(&author, &entry_hash, &v) {
                    return e;
                }
                if let Err(e) = self.gate_rate(&hex::encode(author)) {
                    return e;
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.append_log_entry(&LogEntry {
                    author,
                    seq,
                    obj_id,
                    sig,
                }) {
                    Ok(committed) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({"seq": committed})),
                    ),
                    Err(e) => Response::error(400, e),
                }
            }
            ("GET", p) if p.starts_with("/log/") => {
                let author = match hex32(&p["/log/".len()..]) {
                    Ok(a) => a,
                    Err(e) => return Response::error(400, e),
                };
                let since = query
                    .get("since")
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(0);
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.load_log(&author) {
                    Ok(log) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&portal_replication::log_reply_json(&log, since)),
                    ),
                    Err(e) => Response::error(500, e),
                }
            }
            ("GET", "/heads") => {
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.heads() {
                    Ok(heads) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&portal_replication::heads_reply_json(&heads)),
                    ),
                    Err(e) => Response::error(500, e),
                }
            }
            _ => Response::error(404, "unknown route"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;
    use nym_hidden_service::dispatch;

    fn test_service() -> PortalService {
        PortalService::with_limits(
            Store::open_in_memory().unwrap(),
            0,
            portal_reputation::rate::RatePolicy::default(),
        )
    }

    fn envelope(method: &str, path: &str, body: &[u8]) -> Vec<u8> {
        provider_runtime::route::envelope(method, path, body)
    }

    fn publish(svc: &PortalService, seed: u8, kind: &str, payload: &[u8]) -> (String, [u8; 32]) {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
        let obj = Object::sign_new(&sk, kind, payload.to_vec()).unwrap();
        let raw = envelope("POST", "/obj", obj.to_json().to_string().as_bytes());
        let rep = Response::from_json(&dispatch(svc, &raw)).unwrap();
        assert_eq!(rep.status, 200, "publish failed: {:?}", rep.error);
        (obj.id_hex(), sk.verifying_key().to_bytes())
    }

    #[test]
    fn publish_fetch_and_log_flow() {
        let svc = test_service();
        let sk = ed25519_dalek::SigningKey::from_bytes(&[8u8; 32]);
        let author = sk.verifying_key().to_bytes();
        let author_hex = hex::encode(author);
        let (id_hex, _) = publish(&svc, 8, "post", b"portal hello");

        // Fetch by content id.
        let raw = envelope("GET", &format!("/obj/{id_hex}"), &[]);
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        assert_eq!(rep.status, 200);
        let fetched: serde_json::Value =
            serde_json::from_slice(&rep.body().unwrap()).unwrap();
        assert_eq!(fetched["id"], id_hex);

        // Unknown id: 404.
        let raw = envelope("GET", &format!("/obj/{}", "00".repeat(32)), &[]);
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 404);

        // Append to the log, then read it back.
        let id: [u8; 32] = hex::decode(&id_hex).unwrap().try_into().unwrap();
        let sig = sk
            .sign(&portal_data::log::entry_bytes(&author, 0, &id))
            .to_bytes();
        let body = serde_json::json!({
            "author": author_hex, "seq": 0,
            "obj_id": id_hex, "sig": hex::encode(sig),
        });
        let raw = envelope("POST", "/log-entry", body.to_string().as_bytes());
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        assert_eq!(rep.status, 200);

        let raw = envelope("GET", &format!("/log/{author_hex}?since=0"), &[]);
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        let log_body: serde_json::Value =
            serde_json::from_slice(&rep.body().unwrap()).unwrap();
        assert_eq!(log_body["entries"].as_array().unwrap().len(), 1);
        assert_eq!(log_body["head"], 1);

        // Heads advertise the author.
        let raw = envelope("GET", "/heads", &[]);
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        let heads: serde_json::Value =
            serde_json::from_slice(&rep.body().unwrap()).unwrap();
        assert_eq!(heads["heads"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn forged_objects_and_entries_are_refused() {
        let svc = test_service();
        // Not an object at all.
        let raw = envelope("POST", "/obj", b"{\"kind\":\"post\"}");
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 400);
        // Tampered payload with a real signature shape.
        let (id_hex, _) = publish(&svc, 9, "post", b"real");
        let raw = envelope("GET", &format!("/obj/{id_hex}"), &[]);
        let rep = Response::from_json(&dispatch(&svc, &raw)).unwrap();
        let mut tampered: serde_json::Value =
            serde_json::from_slice(&rep.body().unwrap()).unwrap();
        tampered["payload"] = serde_json::json!("aGk="); // "hi", wrong sig
        let raw = envelope("POST", "/obj", tampered.to_string().as_bytes());
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 400);
    }

    fn pow_for(author: &[u8; 32], obj_id: &[u8; 32], bits: u32) -> serde_json::Value {
        let proof =
            portal_reputation::pow::prove(author, obj_id, bits, 0, 10_000_000).expect("low-bit proof");
        serde_json::json!({"nonce": proof.nonce, "bits": proof.bits})
    }

    #[test]
    fn pow_and_rate_limits_gate_writes() {
        use portal_reputation::rate::RatePolicy;

        let svc = PortalService::with_limits(
            Store::open_in_memory().unwrap(),
            4,
            RatePolicy { max_per_day: 2 },
        );
        let sk = ed25519_dalek::SigningKey::from_bytes(&[8u8; 32]);

        // Missing proof refused when required.
        let obj = Object::sign_new(&sk, "post", b"no pow".to_vec()).unwrap();
        let raw = envelope("POST", "/obj", obj.to_json().to_string().as_bytes());
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 400);

        // Valid proof accepted.
        let mut with_pow = obj.to_json();
        with_pow["pow"] = pow_for(&obj.author, &obj.id, 4);
        let raw = envelope("POST", "/obj", with_pow.to_string().as_bytes());
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 200);

        // Second write spends the last budget...
        let obj2 = Object::sign_new(&sk, "post", b"second".to_vec()).unwrap();
        let mut with_pow2 = obj2.to_json();
        with_pow2["pow"] = pow_for(&obj2.author, &obj2.id, 4);
        let raw = envelope("POST", "/obj", with_pow2.to_string().as_bytes());
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 200);

        // ...and the third hits 429.
        let obj3 = Object::sign_new(&sk, "post", b"third".to_vec()).unwrap();
        let mut with_pow3 = obj3.to_json();
        with_pow3["pow"] = pow_for(&obj3.author, &obj3.id, 4);
        let raw = envelope("POST", "/obj", with_pow3.to_string().as_bytes());
        assert_eq!(Response::from_json(&dispatch(&svc, &raw)).unwrap().status, 429);
    }
}
