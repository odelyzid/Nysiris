//! Hidden-service routes for nysiris-shop.
//!
//! Transport envelope: [`nym_hidden_service`] `Request`/`Response` JSON.
//! Service API bodies are JSON; every write carries an ed25519 signature
//! verified here before anything touches SQLite (`shop_format::sig`).
//!
//! ```text
//! GET  /                                -> service descriptor
//! GET  /health                          -> {ok, listings, orders}
//! GET  /listings?offset=&limit=&q=&seller=  -> {listings:[...], next}
//! GET  /listing/<hex32>                 -> one listing
//! POST /listing                         -> {ok, id}   (create/update, versioned)
//! POST /listing/<hex32>/delete          -> {ok}
//! POST /order                           -> {ok, id}   (reserves stock)
//! GET  /orders?for=<hex64>&day=&sig=<hex128> -> {orders:[...]} (proof of possession)
//! POST /order/<hex32>/status            -> {ok, status}
//! POST /order/<hex32>/message           -> {ok}
//! GET  /order/<hex32>/messages?for=&day=&sig=&offset=&limit= -> paged thread
//! POST /review                          -> {ok}
//! GET  /reviews/<hex64>?offset=&limit=  -> {reviews:[...], summary}
//! POST /escrow/open                     -> {ok, session} (buyer-signed, order-bound)
//! POST /escrow/event                    -> {ok, session} (one signed envelope)
//! GET  /escrow?for=<hex64>&day=&sig=    -> {sessions:[...]} (participants only)
//! GET  /escrow/<hex32>?for=&day=&sig=   -> {session, events:[...]} (participants only)
//! ```
//!
//! Orders are private: `GET /orders` needs a signature from the buyer or
//! seller key, so a public key cannot be used to enumerate purchases.
//! Reviews are public but raw and signed; the aggregate is computed by
//! clients, never stored.

use std::collections::HashMap;
use std::sync::Mutex;

use escrow_format::message::{decode, verify_message, Decoded, Domain};
use nym_hidden_service::{HiddenService, Request, Response};
use provider_runtime::route::{json_body, parse_query};
use provider_runtime::Router;
use shop_format::{limits, pow, review, sig, status::OrderStatus};

use crate::store::{
    EscrowEvent, EscrowSession, MessagePage, Order, OrderMessage, Review, StatusEvent, Store,
};

pub struct ShopService {
    store: Mutex<Store>,
    router: Router,
}

impl ShopService {
    /// `pow_bits`: required PoW difficulty, advertised in `GET /` (0 = off).
    /// `policy`: per-key daily write budget.
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

    /// PoW + rate gate for one write. The PoW binds `(key, payload_hash)`,
    /// where the preimage commits to the exact fields the signature covers.
    fn gate(&self, key: &[u8; 32], preimage: &[u8], v: &serde_json::Value) -> Result<(), Response> {
        let hash = portal_reputation::pow::payload_hash(preimage);
        self.router
            .pow
            .verify_json(key, &hash, v)
            .map_err(|msg| Response::error(400, msg))?;
        self.router
            .rate
            .check(&hex::encode(key))
            .map_err(|msg| Response::error(429, msg))
    }
}

fn descriptor_json(pow_bits: u32) -> serde_json::Value {
    serde_json::json!({
        "service": "nysiris-shop",
        "version": "0.1.0",
        "pow_bits": pow_bits,
        "price_unit": "minor",
        "routes": [
            "GET /health",
            "GET /listings?offset=<n>&limit=<n>&q=<text>&seller=<hex64>",
            "GET /listing/<hex32>",
            "POST /listing",
            "POST /listing/<hex32>/delete",
            "POST /order",
            "GET /orders?for=<hex64>&day=<n>&sig=<hex128>",
            "POST /order/<hex32>/status",
            "POST /order/<hex32>/message",
            "GET /order/<hex32>/messages?for=<hex64>&day=<n>&sig=<hex128>&offset=<n>&limit=<n>",
            "POST /review",
            "GET /reviews/<hex64>?offset=<n>&limit=<n>",
            "POST /escrow/open",
            "POST /escrow/event",
            "GET /escrow?for=<hex64>&day=<n>&sig=<hex128>",
            "GET /escrow/<hex32>?for=<hex64>&day=<n>&sig=<hex128>",
        ],
    })
}

const DESCRIPTOR_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<meta name=\"color-scheme\" content=\"light dark\">\
<title>nysiris-shop</title>\
<style>body{font-family:system-ui,-apple-system,\"Segoe UI\",sans-serif;\
max-width:44rem;margin:2rem auto;padding:0 1rem;line-height:1.6}\
h1,h2{line-height:1.2}code{background:rgba(127,127,127,.15);\
padding:.1em .35em;border-radius:.3em}li{margin:.25em 0}</style></head><body>\
<h1>nysiris-shop</h1>\
<p>A signed, metadata-minimal marketplace reachable only over the Nym mixnet.</p>\
<h2>Browse &amp; sell</h2>\
<ul>\
<li><code>GET /health</code> — service counts</li>\
<li><code>GET /listings?offset=&lt;n&gt;&amp;limit=&lt;n&gt;&amp;q=&lt;text&gt;&amp;seller=&lt;hex64&gt;</code> — active listings</li>\
<li><code>GET /listing/&lt;id&gt;</code> — one listing</li>\
<li><code>POST /listing</code> — signed create/update; <code>version</code> must increase</li>\
<li><code>POST /listing/&lt;id&gt;/delete</code> — signed soft-delete by the seller</li>\
</ul>\
<h2>Orders</h2>\
<ul>\
<li><code>POST /order</code> — buyer-signed reservation; availability is derived atomically from open orders</li>\
<li><code>GET /orders?for=&lt;key&gt;&amp;day=&lt;n&gt;&amp;sig=…</code> — private list for buyer or seller only</li>\
<li><code>POST /order/&lt;id&gt;/status</code> — seller accept/decline/fulfil, buyer cancel; the signed transition is stored for client replay</li>\
<li><code>POST /order/&lt;id&gt;/message</code> — participant-only thread for this order (500-message cap)</li>\
<li><code>GET /order/&lt;id&gt;/messages?for=&lt;key&gt;&amp;day=&lt;n&gt;&amp;sig=…&amp;offset=&lt;n&gt;&amp;limit=&lt;n&gt;</code> — older thread pages</li>\
</ul>\
<h2>Reputation</h2>\
<ul>\
<li><code>POST /review</code> — one buyer-signed review per fulfilled order</li>\
<li><code>GET /reviews/&lt;seller&gt;?offset=&lt;n&gt;&amp;limit=&lt;n&gt;</code> — raw signed reviews; clients aggregate locally</li>\
</ul>\
<h2>Escrow relay (stagenet reference)</h2>\
<ul>\
<li><code>POST /escrow/open</code> — buyer-signed envelope bound to a signed XMR order</li>\
<li><code>POST /escrow/event</code> — one signed setup/funding/payout/dispute envelope; replayed before acceptance</li>\
<li><code>GET /escrow?for=&lt;key&gt;&amp;day=&lt;n&gt;&amp;sig=…</code> — sessions for a participant</li>\
<li><code>GET /escrow/&lt;order&gt;?for=&lt;key&gt;&amp;day=&lt;n&gt;&amp;sig=…</code> — signed envelope log for replay</li>\
</ul>\
<p>No accounts, no carts, no payment processing, no trusted server score. \
Review responses include a convenience aggregate, but clients re-verify every \
signed row and recompute reputation themselves. The escrow relay stores signed \
envelopes for external wallets; it has no keys and never holds funds. Prices are \
integer minor units; shipping details never belong on this service.</p>\
</body></html>";

fn listing_json(l: &crate::store::Listing) -> serde_json::Value {
    serde_json::json!({
        "id": l.id_hex, "seller": l.seller_hex, "day": l.day,
        "version": l.version, "price": l.price, "stock": l.stock,
        "available": l.available, "currency": l.currency,
        "title": l.title, "description": l.description,
        "active": l.active, "sig": l.sig_hex,
    })
}

fn message_json(m: &OrderMessage) -> serde_json::Value {
    serde_json::json!({
        "author": m.author_hex, "day": m.day, "body": m.body, "sig": m.sig_hex,
    })
}

fn review_json(r: &Review) -> serde_json::Value {
    serde_json::json!({
        "order": r.order_hex, "seller": r.seller_hex, "author": r.author_hex,
        "rating": r.rating, "body": r.body, "day": r.day, "sig": r.sig_hex,
    })
}

fn status_event_json(e: &StatusEvent) -> serde_json::Value {
    serde_json::json!({
        "from_code": e.from_code, "status_code": e.status_code,
        "actor": e.actor_hex, "day": e.day, "note": e.note, "sig": e.sig_hex,
    })
}

fn order_json(
    o: &Order,
    messages: &MessagePage,
    review: Option<&Review>,
    events: &[StatusEvent],
) -> serde_json::Value {
    let status = OrderStatus::from_code(o.status)
        .map(|s| s.as_str())
        .unwrap_or("unknown");
    serde_json::json!({
        "id": o.id_hex, "listing": o.listing_hex, "buyer": o.buyer_hex,
        "seller": o.seller_hex, "qty": o.qty, "note": o.note,
        "price": o.price, "version": o.version,
        "status": status, "status_code": o.status, "day": o.day, "sig": o.sig_hex,
        "status_events": events.iter().map(status_event_json).collect::<Vec<_>>(),
        "messages": messages.messages.iter().map(message_json).collect::<Vec<_>>(),
        "messages_total": messages.total,
        "messages_next_offset": messages.next_offset,
        "review": review.map(review_json),
    })
}

fn escrow_session_json(s: &EscrowSession) -> serde_json::Value {
    serde_json::json!({
        "order": s.order_hex, "nonce": s.nonce_hex,
        "buyer": s.buyer_hex, "seller": s.seller_hex, "arbiter": s.arbiter_hex,
        "amount": s.amount, "currency": "XMR", "stage": s.stage, "day": s.day,
    })
}

fn escrow_event_json(e: &EscrowEvent) -> serde_json::Value {
    serde_json::json!({
        "domain": e.domain, "actor": e.actor_hex, "day": e.day,
        "seq": e.seq, "envelope": e.envelope_hex,
    })
}

// ---- request field helpers ----

fn field_str<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v.get(key).and_then(|s| s.as_str()).unwrap_or("")
}

fn field_pubkey(v: &serde_json::Value, key: &str) -> Result<[u8; 32], Response> {
    v.get(key)
        .and_then(|s| s.as_str())
        .map(sig::parse_pubkey)
        .transpose()
        .map_err(|e| Response::error(400, e))?
        .ok_or_else(|| Response::error(400, format!("missing {key}")))
}

fn field_sig(v: &serde_json::Value) -> Result<ed25519_dalek::Signature, Response> {
    v.get("sig")
        .and_then(|s| s.as_str())
        .map(sig::parse_sig)
        .transpose()
        .map_err(|e| Response::error(400, e))?
        .ok_or_else(|| Response::error(400, "missing sig"))
}

fn path_id16(s: &str, label: &str) -> Result<[u8; 16], Response> {
    let bytes =
        hex::decode(s.trim()).map_err(|_| Response::error(400, format!("{label} must be hex")))?;
    if bytes.len() != 16 {
        return Err(Response::error(
            400,
            format!("{label} must be a 16-byte id"),
        ));
    }
    let mut out = [0u8; 16];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn field_id16(v: &serde_json::Value, key: &str) -> Result<[u8; 16], Response> {
    let s = v
        .get(key)
        .and_then(|x| x.as_str())
        .ok_or_else(|| Response::error(400, format!("missing {key}")))?;
    path_id16(s, key)
}

fn decoded_order(d: &Decoded) -> [u8; 16] {
    match d {
        Decoded::Open { order, .. }
        | Decoded::Join { order, .. }
        | Decoded::Commit { order, .. }
        | Decoded::Funded { order, .. }
        | Decoded::Release { order, .. }
        | Decoded::Approve { order, .. }
        | Decoded::Dispute { order, .. }
        | Decoded::Resolve { order, .. }
        | Decoded::Cancel { order, .. }
        | Decoded::Submitted { order, .. } => *order,
    }
}

fn field_envelope(v: &serde_json::Value, key: &str) -> Result<Vec<u8>, Response> {
    let s = v
        .get(key)
        .and_then(|x| x.as_str())
        .ok_or_else(|| Response::error(400, format!("missing {key}")))?;
    let raw =
        hex::decode(s.trim()).map_err(|_| Response::error(400, format!("{key} must be hex")))?;
    if raw.is_empty() || raw.len() > escrow_format::limits::MAX_ENVELOPE_BYTES {
        return Err(Response::error(
            400,
            "escrow envelope has an invalid length",
        ));
    }
    Ok(raw)
}

/// A missing or wrongly typed number is a client error, never a silent zero
/// that later surfaces as a misleading "value must be positive" rejection.
fn required_u64(v: &serde_json::Value, key: &str) -> Result<u64, Response> {
    v.get(key)
        .and_then(|x| x.as_u64())
        .ok_or_else(|| Response::error(400, format!("{key} must be an unsigned integer")))
}

fn required_u32(v: &serde_json::Value, key: &str) -> Result<u32, Response> {
    let n = required_u64(v, key)?;
    u32::try_from(n).map_err(|_| Response::error(400, format!("{key} is out of range")))
}

fn required_u8(v: &serde_json::Value, key: &str) -> Result<u8, Response> {
    let n = required_u64(v, key)?;
    u8::try_from(n).map_err(|_| Response::error(400, format!("{key} is out of range")))
}

fn fresh_day(day: u64) -> Result<(), Response> {
    if day.abs_diff(sig::current_day()) > 2 {
        return Err(Response::error(
            400,
            "stale day: re-sign with the current UTC day",
        ));
    }
    Ok(())
}

/// Proof of possession shared by the private order and thread reads. The
/// signature itself only names the key and day; the route still checks that
/// the key is a participant before returning any rows.
fn signed_read(query: &HashMap<String, String>) -> Result<[u8; 32], Response> {
    let who = match query.get("for").map(|s| sig::parse_pubkey(s)) {
        Some(Ok(k)) => k,
        _ => return Err(Response::error(400, "missing ?for=<pubkey>")),
    };
    let signature = match query.get("sig").map(|s| sig::parse_sig(s)) {
        Some(Ok(s)) => s,
        _ => {
            return Err(Response::error(
                401,
                "private read requires a signature (proof of possession)",
            ))
        }
    };
    let day = match query.get("day").and_then(|d| d.trim().parse::<u64>().ok()) {
        Some(d) => d,
        None => return Err(Response::error(400, "missing ?day=<n>")),
    };
    if day.abs_diff(sig::current_day()) > 2 {
        return Err(Response::error(
            401,
            "stale read (day outside the freshness window)",
        ));
    }
    if sig::verify(&who, &sig::orders_read_message(&who, day), &signature).is_err() {
        return Err(Response::error(
            401,
            "read signature does not match the key",
        ));
    }
    Ok(who)
}

/// UTF-8 text that is safe to concatenate into a signed layout: no interior
/// NUL (the listing title/description separator), within its caps.
fn check_text(
    value: &str,
    label: &str,
    max_chars: Option<usize>,
    max_bytes: Option<usize>,
) -> Result<(), Response> {
    if value.contains('\0') {
        return Err(Response::error(400, format!("{label} contains NUL")));
    }
    if let Some(max) = max_chars {
        if value.chars().count() > max {
            return Err(Response::error(400, format!("{label} too long")));
        }
    }
    if let Some(max) = max_bytes {
        if value.as_bytes().len() > max {
            return Err(Response::error(400, format!("{label} too long")));
        }
    }
    Ok(())
}

fn id_from_hex(hex: &str, what: &str) -> Result<[u8; 16], Response> {
    let bytes =
        hex::decode(hex.trim()).map_err(|_| Response::error(400, format!("{what} must be hex")))?;
    if bytes.len() != 16 {
        return Err(Response::error(400, format!("{what} must be a 16-byte id")));
    }
    let mut out = [0u8; 16];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn not_found(what: &str) -> Response {
    Response::error(404, format!("no such {what}"))
}

impl HiddenService for ShopService {
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
                    // The scale is a wire constant mirrored in the browser;
                    // show its actual value instead of a vague "minor units".
                    let html = DESCRIPTOR_HTML.replace(
                        "Prices are integer minor units;",
                        &format!(
                            "Prices are integer minor units ({} = 1 major unit);",
                            limits::PRICE_MINOR_UNITS
                        ),
                    );
                    Response::ok(200, "text/html", html.as_bytes())
                } else {
                    Response::ok(
                        200,
                        "application/json",
                        &json_body(&descriptor_json(self.router.pow.bits())),
                    )
                }
            }
            ("GET", "/health") => {
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.counts() {
                    Ok((listings, orders)) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({
                            "ok": true, "listings": listings, "orders": orders,
                        })),
                    ),
                    Err(e) => Response::error(500, e),
                }
            }
            ("GET", "/listings") => {
                let offset = query
                    .get("offset")
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(0);
                let limit = query
                    .get("limit")
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(limits::DEFAULT_LISTINGS_PAGE);
                let q = query.get("q").map(String::as_str).unwrap_or("");
                let seller = match query.get("seller") {
                    None => None,
                    Some(s) => match sig::parse_pubkey(s) {
                        Ok(k) => Some(k),
                        Err(e) => return Response::error(400, e),
                    },
                };
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.list_listings(offset, limit, q, seller.as_ref()) {
                    Ok(items) => {
                        let next = if items.len() >= limit.clamp(1, limits::MAX_LISTINGS_PAGE) {
                            Some(offset + items.len())
                        } else {
                            None
                        };
                        Response::ok(
                            200,
                            "application/json",
                            &json_body(&serde_json::json!({
                                "listings": items.iter().map(listing_json).collect::<Vec<_>>(),
                                "next": next,
                            })),
                        )
                    }
                    Err(e) => Response::error(500, e),
                }
            }
            ("GET", p) if p.starts_with("/listing/") && !p.ends_with("/delete") => {
                let id = match id_from_hex(&p["/listing/".len()..], "listing id") {
                    Ok(id) => id,
                    Err(e) => return e,
                };
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.get_listing(&id) {
                    Ok(Some(listing)) => {
                        Response::ok(200, "application/json", &json_body(&listing_json(&listing)))
                    }
                    Ok(None) => not_found("listing"),
                    Err(e) => Response::error(500, e),
                }
            }
            ("POST", "/listing") => {
                let v: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => return Response::error(400, "listing body must be JSON"),
                };
                let seller = match field_pubkey(&v, "seller") {
                    Ok(k) => k,
                    Err(e) => return e,
                };
                let id = match field_id16(&v, "id") {
                    Ok(id) => id,
                    Err(e) => return e,
                };
                let sig = match field_sig(&v) {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let day = match required_u64(&v, "day") {
                    Ok(n) => n,
                    Err(e) => return e,
                };
                if let Err(e) = fresh_day(day) {
                    return e;
                }
                let version = match required_u64(&v, "version") {
                    Ok(n) => n,
                    Err(e) => return e,
                };
                if version == 0 {
                    return Response::error(400, "version must be positive");
                }
                // Zero is a legitimate price (a free listing); only a missing
                // or malformed field is rejected here.
                let price = match required_u64(&v, "price") {
                    Ok(n) => n,
                    Err(e) => return e,
                };
                let stock = match required_u32(&v, "stock") {
                    Ok(n) => n,
                    Err(e) => return e,
                };
                if stock > limits::MAX_STOCK {
                    return Response::error(400, "stock too large");
                }
                let currency = match sig::parse_currency(field_str(&v, "currency")) {
                    Ok(c) => c,
                    Err(e) => return Response::error(400, e),
                };
                let title = field_str(&v, "title");
                let description = field_str(&v, "description");
                if title.trim().is_empty() {
                    return Response::error(400, "title is required");
                }
                if let Err(e) = check_text(title, "title", Some(limits::MAX_TITLE_CHARS), None) {
                    return e;
                }
                if let Err(e) = check_text(
                    description,
                    "description",
                    Some(limits::MAX_DESCRIPTION_CHARS),
                    None,
                ) {
                    return e;
                }
                let message = sig::listing_message(
                    &seller,
                    day,
                    &id,
                    version,
                    price,
                    stock,
                    &currency,
                    title,
                    description,
                );
                if sig::verify(&seller, &message, &sig).is_err() {
                    return Response::error(400, "signature verification failed");
                }
                let preimage = pow::listing_pow_preimage(
                    &id,
                    version,
                    price,
                    stock,
                    &currency,
                    title,
                    description,
                );
                if let Err(e) = self.gate(&seller, &preimage, &v) {
                    return e;
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let result = store.upsert_listing(
                    &id,
                    &seller,
                    day,
                    version,
                    price,
                    stock,
                    &currency,
                    title,
                    description,
                    &sig.to_bytes(),
                );
                if result.is_err() {
                    self.router.rate.refund(&hex::encode(seller));
                }
                match result {
                    Ok(()) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({"ok": true, "id": hex::encode(id)})),
                    ),
                    Err(e) => Response::error(400, e),
                }
            }
            ("POST", p) if p.starts_with("/listing/") && p.ends_with("/delete") => {
                let id = match id_from_hex(
                    &p["/listing/".len()..p.len() - "/delete".len()],
                    "listing id",
                ) {
                    Ok(id) => id,
                    Err(e) => return e,
                };
                let v: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => return Response::error(400, "delete body must be JSON"),
                };
                let seller = match field_pubkey(&v, "seller") {
                    Ok(k) => k,
                    Err(e) => return e,
                };
                let sig = match field_sig(&v) {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let day = match required_u64(&v, "day") {
                    Ok(n) => n,
                    Err(e) => return e,
                };
                if let Err(e) = fresh_day(day) {
                    return e;
                }
                if sig::verify(
                    &seller,
                    &sig::listing_delete_message(&seller, &id, day),
                    &sig,
                )
                .is_err()
                {
                    return Response::error(400, "signature verification failed");
                }
                if let Err(e) = self.gate(&seller, &pow::listing_delete_pow_preimage(&id), &v) {
                    return e;
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let result = store.delete_listing(&seller, &id);
                if result.is_err() || result == Ok(false) {
                    self.router.rate.refund(&hex::encode(seller));
                }
                match result {
                    Ok(true) => Response::ok(200, "application/json", b"{\"ok\":true}"),
                    Ok(false) => not_found("listing owned by that key"),
                    Err(e) => Response::error(500, e),
                }
            }
            ("POST", "/order") => {
                let v: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => return Response::error(400, "order body must be JSON"),
                };
                let buyer = match field_pubkey(&v, "buyer") {
                    Ok(k) => k,
                    Err(e) => return e,
                };
                let id = match field_id16(&v, "id") {
                    Ok(id) => id,
                    Err(e) => return e,
                };
                let listing = match field_id16(&v, "listing") {
                    Ok(id) => id,
                    Err(e) => return e,
                };
                let sig = match field_sig(&v) {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let day = match required_u64(&v, "day") {
                    Ok(n) => n,
                    Err(e) => return e,
                };
                if let Err(e) = fresh_day(day) {
                    return e;
                }
                let qty = match required_u32(&v, "qty") {
                    Ok(n) => n,
                    Err(e) => return e,
                };
                if qty == 0 || qty > limits::MAX_ORDER_QTY {
                    return Response::error(
                        400,
                        format!("qty must be 1..={}", limits::MAX_ORDER_QTY),
                    );
                }
                // Terms are signed and frozen; the store refuses a mismatch
                // with the current listing row. A free listing has price 0, so
                // only a missing/malformed field is rejected here.
                let price = match required_u64(&v, "price") {
                    Ok(n) => n,
                    Err(e) => return e,
                };
                let version = match required_u64(&v, "version") {
                    Ok(n) => n,
                    Err(e) => return e,
                };
                if version == 0 {
                    return Response::error(400, "version must be positive");
                }
                let note = field_str(&v, "note");
                if let Err(e) = check_text(note, "note", None, Some(limits::MAX_NOTE_BYTES)) {
                    return e;
                }
                if sig::verify(
                    &buyer,
                    &sig::order_message(&buyer, day, &listing, &id, qty, price, version, note),
                    &sig,
                )
                .is_err()
                {
                    return Response::error(400, "signature verification failed");
                }
                if let Err(e) = self.gate(
                    &buyer,
                    &pow::order_pow_preimage(&listing, &id, qty, price, version, note),
                    &v,
                ) {
                    return e;
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let result = store.insert_order(
                    &id,
                    &listing,
                    &buyer,
                    day,
                    qty,
                    price,
                    version,
                    note,
                    &sig.to_bytes(),
                );
                if result.is_err() {
                    self.router.rate.refund(&hex::encode(buyer));
                }
                match result {
                    Ok(()) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({
                            "ok": true, "id": hex::encode(id), "status": "reserved",
                        })),
                    ),
                    Err(e) => Response::error(400, e),
                }
            }
            ("GET", "/orders") => {
                let who = match signed_read(&query) {
                    Ok(k) => k,
                    Err(e) => return e,
                };
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let details =
                    match store.orders_with_details_for(&who, limits::DEFAULT_MESSAGES_PAGE) {
                        Ok(d) => d,
                        Err(e) => return Response::error(500, e),
                    };
                let items = details
                    .iter()
                    .map(|d| order_json(&d.order, &d.messages, d.review.as_ref(), &d.events))
                    .collect::<Vec<_>>();
                Response::ok(
                    200,
                    "application/json",
                    &json_body(&serde_json::json!({"orders": items})),
                )
            }
            ("GET", p) if p.starts_with("/order/") && p.ends_with("/messages") => {
                let id =
                    match id_from_hex(&p["/order/".len()..p.len() - "/messages".len()], "order id")
                    {
                        Ok(id) => id,
                        Err(e) => return e,
                    };
                let who = match signed_read(&query) {
                    Ok(k) => k,
                    Err(e) => return e,
                };
                let offset = query
                    .get("offset")
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(0);
                let limit = query
                    .get("limit")
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(limits::DEFAULT_MESSAGES_PAGE);
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.order_parties(&id) {
                    Ok(Some((buyer, seller))) if who == buyer || who == seller => {}
                    Ok(Some(_)) => {
                        return Response::error(403, "only the parties may read this thread")
                    }
                    Ok(None) => return not_found("order"),
                    Err(e) => return Response::error(500, e),
                }
                match store.messages_for(&id, offset, limit) {
                    Ok(page) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({
                            "order": hex::encode(id),
                            "messages": page.messages.iter().map(message_json).collect::<Vec<_>>(),
                            "total": page.total,
                            "next_offset": page.next_offset,
                        })),
                    ),
                    Err(e) => Response::error(500, e),
                }
            }
            ("POST", p) if p.starts_with("/order/") && p.ends_with("/status") => {
                let id =
                    match id_from_hex(&p["/order/".len()..p.len() - "/status".len()], "order id") {
                        Ok(id) => id,
                        Err(e) => return e,
                    };
                let v: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => return Response::error(400, "status body must be JSON"),
                };
                let actor = match field_pubkey(&v, "actor") {
                    Ok(k) => k,
                    Err(e) => return e,
                };
                let sig = match field_sig(&v) {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let day = match required_u64(&v, "day") {
                    Ok(n) => n,
                    Err(e) => return e,
                };
                if let Err(e) = fresh_day(day) {
                    return e;
                }
                let code = match required_u8(&v, "status") {
                    Ok(n) => n,
                    Err(e) => return e,
                };
                let next = match OrderStatus::from_code(code) {
                    Some(s) if s != OrderStatus::Reserved => s,
                    _ => {
                        return Response::error(
                            400,
                            "status must be accepted, declined, cancelled, or fulfilled",
                        )
                    }
                };
                let note = field_str(&v, "note");
                if let Err(e) = check_text(note, "note", None, Some(limits::MAX_NOTE_BYTES)) {
                    return e;
                }
                if sig::verify(
                    &actor,
                    &sig::order_status_message(&actor, day, &id, next.code(), note),
                    &sig,
                )
                .is_err()
                {
                    return Response::error(400, "signature verification failed");
                }
                if let Err(e) = self.gate(
                    &actor,
                    &pow::order_status_pow_preimage(&id, next.code(), note),
                    &v,
                ) {
                    return e;
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let result =
                    store.update_order_status(&id, &actor, next, day, note, &sig.to_bytes());
                if result.is_err() {
                    self.router.rate.refund(&hex::encode(actor));
                }
                match result {
                    Ok(()) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({"ok": true, "status": next.as_str()})),
                    ),
                    Err(e) if e == "no such order" => not_found("order"),
                    Err(e) => Response::error(400, e),
                }
            }
            ("POST", p) if p.starts_with("/order/") && p.ends_with("/message") => {
                let id = match id_from_hex(
                    &p["/order/".len()..p.len() - "/message".len()],
                    "order id",
                ) {
                    Ok(id) => id,
                    Err(e) => return e,
                };
                let v: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => return Response::error(400, "message body must be JSON"),
                };
                let author = match field_pubkey(&v, "author") {
                    Ok(k) => k,
                    Err(e) => return e,
                };
                let sig = match field_sig(&v) {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let day = match required_u64(&v, "day") {
                    Ok(n) => n,
                    Err(e) => return e,
                };
                if let Err(e) = fresh_day(day) {
                    return e;
                }
                let text = field_str(&v, "body");
                if text.trim().is_empty() {
                    return Response::error(400, "message body is required");
                }
                if let Err(e) = check_text(text, "message", None, Some(limits::MAX_MESSAGE_BYTES)) {
                    return e;
                }
                if sig::verify(
                    &author,
                    &sig::order_message_body(&author, day, &id, text),
                    &sig,
                )
                .is_err()
                {
                    return Response::error(400, "signature verification failed");
                }
                if let Err(e) = self.gate(&author, &pow::order_message_pow_preimage(&id, text), &v)
                {
                    return e;
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.order_parties(&id) {
                    Ok(Some((buyer, seller))) => {
                        if author != buyer && author != seller {
                            return Response::error(403, "only the buyer or seller may message");
                        }
                    }
                    Ok(None) => return not_found("order"),
                    Err(e) => return Response::error(500, e),
                }
                let result = store.insert_order_message(&id, &author, day, text, &sig.to_bytes());
                if result.is_err() {
                    self.router.rate.refund(&hex::encode(author));
                }
                match result {
                    Ok(()) => Response::ok(200, "application/json", b"{\"ok\":true}"),
                    Err(e) => Response::error(400, e),
                }
            }
            ("POST", "/review") => {
                let v: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => return Response::error(400, "review body must be JSON"),
                };
                let author = match field_pubkey(&v, "author") {
                    Ok(k) => k,
                    Err(e) => return e,
                };
                let order = match field_id16(&v, "order") {
                    Ok(id) => id,
                    Err(e) => return e,
                };
                let seller = match field_pubkey(&v, "seller") {
                    Ok(k) => k,
                    Err(e) => return e,
                };
                let sig = match field_sig(&v) {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let day = match required_u64(&v, "day") {
                    Ok(n) => n,
                    Err(e) => return e,
                };
                if let Err(e) = fresh_day(day) {
                    return e;
                }
                let rating = match required_u8(&v, "rating") {
                    Ok(n) => n,
                    Err(e) => return e,
                };
                if !review::rating_is_valid(rating) {
                    return Response::error(400, "rating must be 1..=5");
                }
                let text = field_str(&v, "body");
                if let Err(e) = check_text(text, "review", None, Some(limits::MAX_REVIEW_BYTES)) {
                    return e;
                }
                if sig::verify(
                    &author,
                    &sig::review_message(&author, day, &order, &seller, rating, text),
                    &sig,
                )
                .is_err()
                {
                    return Response::error(400, "signature verification failed");
                }
                if let Err(e) = self.gate(
                    &author,
                    &pow::review_pow_preimage(&order, &seller, rating, text),
                    &v,
                ) {
                    return e;
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let result = store.insert_review(
                    &order,
                    &author,
                    &seller,
                    rating,
                    text,
                    day,
                    &sig.to_bytes(),
                );
                if result.is_err() {
                    self.router.rate.refund(&hex::encode(author));
                }
                match result {
                    Ok(()) => Response::ok(200, "application/json", b"{\"ok\":true}"),
                    Err(e) if e == "no such order" => not_found("order"),
                    Err(e) => Response::error(400, e),
                }
            }
            ("GET", p) if p.starts_with("/reviews/") => {
                let seller = match sig::parse_pubkey(&p["/reviews/".len()..]) {
                    Ok(k) => k,
                    Err(e) => return Response::error(400, e),
                };
                let offset = query
                    .get("offset")
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(0);
                let limit = query
                    .get("limit")
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(limits::DEFAULT_LISTINGS_PAGE);
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.reviews_for_seller(&seller, offset, limit) {
                    Ok(items) => {
                        let (count, sum) = match store.review_summary(&seller) {
                            Ok(v) => v,
                            Err(e) => return Response::error(500, e),
                        };
                        // The summary describes ALL of this seller's reviews,
                        // not just the returned page. Clients still re-verify
                        // raw reviews and recompute their own aggregate.
                        let summary = review::ReviewSummary {
                            count: count as usize,
                            sum,
                        };
                        Response::ok(
                            200,
                            "application/json",
                            &json_body(&serde_json::json!({
                                "seller": hex::encode(seller),
                                "reviews": items.iter().map(review_json).collect::<Vec<_>>(),
                                "summary": {
                                    "count": count,
                                    "sum": sum,
                                    "average_x100": summary.average_x100(),
                                },
                            })),
                        )
                    }
                    Err(e) => Response::error(500, e),
                }
            }
            ("POST", "/escrow/open") => {
                let v: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => return Response::error(400, "escrow open body must be JSON"),
                };
                let order = match field_id16(&v, "order") {
                    Ok(id) => id,
                    Err(e) => return e,
                };
                let envelope = match field_envelope(&v, "envelope") {
                    Ok(raw) => raw,
                    Err(e) => return e,
                };
                let env = match verify_message(&envelope) {
                    Ok(env) => env,
                    Err(e) => return Response::error(400, e),
                };
                let decoded = match decode(&env) {
                    Ok(d) => d,
                    Err(e) => return Response::error(400, e),
                };
                if env.domain != Domain::Open {
                    return Response::error(400, "the open route requires an open envelope");
                }
                if decoded_order(&decoded) != order {
                    return Response::error(400, "envelope names a different order");
                }
                if let Err(e) = fresh_day(env.day) {
                    return e;
                }
                // The PoW binds the exact signed bytes; the rate key is the
                // verified signer, never an unauthenticated request field.
                if let Err(e) = self.gate(&env.actor, &envelope, &v) {
                    return e;
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let result = store.open_escrow(&order, &envelope, sig::current_day());
                if result.is_err() {
                    self.router.rate.refund(&hex::encode(env.actor));
                }
                match result {
                    Ok(session) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({
                            "ok": true, "session": escrow_session_json(&session),
                        })),
                    ),
                    Err(e) => Response::error(400, e),
                }
            }
            ("POST", "/escrow/event") => {
                let v: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => return Response::error(400, "escrow event body must be JSON"),
                };
                let order = match field_id16(&v, "order") {
                    Ok(id) => id,
                    Err(e) => return e,
                };
                let envelope = match field_envelope(&v, "envelope") {
                    Ok(raw) => raw,
                    Err(e) => return e,
                };
                let env = match verify_message(&envelope) {
                    Ok(env) => env,
                    Err(e) => return Response::error(400, e),
                };
                if env.domain == Domain::Open {
                    return Response::error(400, "use /escrow/open to start a session");
                }
                let decoded = match decode(&env) {
                    Ok(d) => d,
                    Err(e) => return Response::error(400, e),
                };
                if decoded_order(&decoded) != order {
                    return Response::error(400, "envelope names a different order");
                }
                if let Err(e) = fresh_day(env.day) {
                    return e;
                }
                if let Err(e) = self.gate(&env.actor, &envelope, &v) {
                    return e;
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let result = store.append_escrow_event(&order, &envelope, sig::current_day());
                if result.is_err() {
                    self.router.rate.refund(&hex::encode(env.actor));
                }
                match result {
                    Ok(session) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({
                            "ok": true, "session": escrow_session_json(&session),
                        })),
                    ),
                    Err(e) => Response::error(400, e),
                }
            }
            ("GET", "/escrow") => {
                let who = match signed_read(&query) {
                    Ok(k) => k,
                    Err(e) => return e,
                };
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                match store.escrow_sessions_for(&who) {
                    Ok(sessions) => Response::ok(
                        200,
                        "application/json",
                        &json_body(&serde_json::json!({
                            "sessions": sessions.iter().map(escrow_session_json).collect::<Vec<_>>(),
                        })),
                    ),
                    Err(e) => Response::error(500, e),
                }
            }
            ("GET", p) if p.starts_with("/escrow/") => {
                let who = match signed_read(&query) {
                    Ok(k) => k,
                    Err(e) => return e,
                };
                let order = match path_id16(&p["/escrow/".len()..], "order") {
                    Ok(id) => id,
                    Err(e) => return e,
                };
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let parties = match store.escrow_parties(&order) {
                    Ok(v) => v,
                    Err(e) => return Response::error(500, e),
                };
                let allowed = parties
                    .map(|(buyer, seller, arbiter)| who == buyer || who == seller || who == arbiter)
                    .unwrap_or(false);
                if !allowed {
                    return not_found("escrow session");
                }
                let session = match store.escrow_session(&order) {
                    Ok(Some(s)) => s,
                    Ok(None) => return not_found("escrow session"),
                    Err(e) => return Response::error(500, e),
                };
                let events = match store.escrow_events(&order) {
                    Ok(v) => v,
                    Err(e) => return Response::error(500, e),
                };
                Response::ok(
                    200,
                    "application/json",
                    &json_body(&serde_json::json!({
                        "session": escrow_session_json(&session),
                        "events": events.iter().map(escrow_event_json).collect::<Vec<_>>(),
                    })),
                )
            }
            _ => Response::error(404, "unknown route"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use escrow_format::message::{
        approve_message, commit_message, digest, funded_message, join_message, open_message,
        release_message, sign_message, submitted_message,
    };
    use nym_hidden_service::dispatch;
    use std::collections::HashMap;

    fn test_service() -> ShopService {
        ShopService::with_limits(
            Store::open_in_memory().unwrap(),
            0,
            portal_reputation::rate::RatePolicy::default(),
        )
    }

    fn envelope(method: &str, path: &str, body: &[u8]) -> Vec<u8> {
        provider_runtime::route::envelope(method, path, body)
    }

    fn post(svc: &ShopService, path: &str, body: &serde_json::Value) -> Response {
        let raw = envelope("POST", path, body.to_string().as_bytes());
        Response::from_json(&dispatch(svc, &raw)).unwrap()
    }

    fn get(svc: &ShopService, path: &str) -> Response {
        let raw = envelope("GET", path, &[]);
        Response::from_json(&dispatch(svc, &raw)).unwrap()
    }

    fn body(rep: &Response) -> serde_json::Value {
        serde_json::from_slice(&rep.body().unwrap()).unwrap()
    }

    fn listing(
        sk: &SigningKey,
        id: [u8; 16],
        version: u64,
        price: u64,
        stock: u32,
        title: &str,
        description: &str,
    ) -> serde_json::Value {
        listing_currency(sk, id, version, price, stock, title, description, "USD")
    }

    #[allow(clippy::too_many_arguments)]
    fn listing_currency(
        sk: &SigningKey,
        id: [u8; 16],
        version: u64,
        price: u64,
        stock: u32,
        title: &str,
        description: &str,
        currency: &str,
    ) -> serde_json::Value {
        let seller = sk.verifying_key().to_bytes();
        let day = sig::current_day();
        let code: [u8; 3] = currency.as_bytes().try_into().unwrap();
        let msg = sig::listing_message(
            &seller,
            day,
            &id,
            version,
            price,
            stock,
            &code,
            title,
            description,
        );
        serde_json::json!({
            "seller": hex::encode(seller), "day": day, "id": hex::encode(id),
            "version": version, "price": price, "stock": stock, "currency": currency,
            "title": title, "description": description,
            "sig": hex::encode(sk.sign(&msg).to_bytes()),
        })
    }

    fn order(
        sk: &SigningKey,
        id: [u8; 16],
        listing: [u8; 16],
        qty: u32,
        price: u64,
        note: &str,
    ) -> serde_json::Value {
        let buyer = sk.verifying_key().to_bytes();
        let day = sig::current_day();
        let version = 1u64;
        let msg = sig::order_message(&buyer, day, &listing, &id, qty, price, version, note);
        serde_json::json!({
            "buyer": hex::encode(buyer), "day": day, "id": hex::encode(id),
            "listing": hex::encode(listing), "qty": qty,
            "price": price, "version": version, "note": note,
            "sig": hex::encode(sk.sign(&msg).to_bytes()),
        })
    }

    fn status_update(
        sk: &SigningKey,
        order_id: [u8; 16],
        status: u8,
        note: &str,
    ) -> serde_json::Value {
        let actor = sk.verifying_key().to_bytes();
        let day = sig::current_day();
        let msg = sig::order_status_message(&actor, day, &order_id, status, note);
        serde_json::json!({
            "actor": hex::encode(actor), "day": day, "status": status, "note": note,
            "sig": hex::encode(sk.sign(&msg).to_bytes()),
        })
    }

    fn message(sk: &SigningKey, order_id: [u8; 16], text: &str) -> serde_json::Value {
        let author = sk.verifying_key().to_bytes();
        let day = sig::current_day();
        let msg = sig::order_message_body(&author, day, &order_id, text);
        serde_json::json!({
            "author": hex::encode(author), "day": day, "body": text,
            "sig": hex::encode(sk.sign(&msg).to_bytes()),
        })
    }

    fn review(
        sk: &SigningKey,
        order_id: [u8; 16],
        seller: &SigningKey,
        rating: u8,
        text: &str,
    ) -> serde_json::Value {
        let author = sk.verifying_key().to_bytes();
        let seller_key = seller.verifying_key().to_bytes();
        let day = sig::current_day();
        let msg = sig::review_message(&author, day, &order_id, &seller_key, rating, text);
        serde_json::json!({
            "author": hex::encode(author), "day": day, "order": hex::encode(order_id),
            "seller": hex::encode(seller_key),
            "rating": rating, "body": text, "sig": hex::encode(sk.sign(&msg).to_bytes()),
        })
    }

    fn orders_path(sk: &SigningKey) -> String {
        let who = sk.verifying_key().to_bytes();
        let day = sig::current_day();
        let signature = sk.sign(&sig::orders_read_message(&who, day));
        format!(
            "/orders?for={}&day={}&sig={}",
            hex::encode(who),
            day,
            hex::encode(signature.to_bytes())
        )
    }

    fn messages_path(sk: &SigningKey, order: [u8; 16], offset: usize, limit: usize) -> String {
        let orders = orders_path(sk);
        format!(
            "/order/{}/messages?{}&offset={}&limit={}",
            hex::encode(order),
            orders.split_once('?').unwrap().1,
            offset,
            limit
        )
    }

    fn escrow_open(
        buyer: &SigningKey,
        seller: &SigningKey,
        arbiter: &SigningKey,
        order: [u8; 16],
        nonce: [u8; 16],
        amount: u64,
    ) -> serde_json::Value {
        let unsigned = open_message(
            &buyer.verifying_key().to_bytes(),
            sig::current_day(),
            0,
            &order,
            &nonce,
            &seller.verifying_key().to_bytes(),
            &arbiter.verifying_key().to_bytes(),
            amount,
            b"XMR",
        )
        .unwrap();
        serde_json::json!({
            "order": hex::encode(order),
            "envelope": hex::encode(sign_message(unsigned, buyer)),
        })
    }

    fn escrow_event(signer: &SigningKey, order: [u8; 16], unsigned: Vec<u8>) -> serde_json::Value {
        serde_json::json!({
            "order": hex::encode(order),
            "envelope": hex::encode(sign_message(unsigned, signer)),
        })
    }

    fn escrow_path(sk: &SigningKey, order: Option<[u8; 16]>) -> String {
        let who = sk.verifying_key().to_bytes();
        let day = sig::current_day();
        let signature = sk.sign(&sig::orders_read_message(&who, day));
        let tail = format!(
            "for={}&day={}&sig={}",
            hex::encode(who),
            day,
            hex::encode(signature.to_bytes())
        );
        match order {
            Some(id) => format!("/escrow/{}?{tail}", hex::encode(id)),
            None => format!("/escrow?{tail}"),
        }
    }

    #[test]
    fn escrow_relay_binds_signed_shop_terms_and_replays_the_log() {
        let svc = test_service();
        let seller = SigningKey::from_bytes(&[31u8; 32]);
        let buyer = SigningKey::from_bytes(&[32u8; 32]);
        let arbiter = SigningKey::from_bytes(&[33u8; 32]);
        let outsider = SigningKey::from_bytes(&[34u8; 32]);
        let listing_id = [0x51; 16];
        let order_id = [0x52; 16];
        let nonce = [0x53; 16];
        let price = 1_000_000_000_000u64; // one XMR in piconeros
        let qty = 2u32;
        let amount = price * u64::from(qty);
        let day = sig::current_day();

        assert_eq!(
            post(
                &svc,
                "/listing",
                &listing_currency(&seller, listing_id, 1, price, 3, "Ore", "XMR item", "XMR")
            )
            .status,
            200
        );
        assert_eq!(
            post(
                &svc,
                "/order",
                &order(&buyer, order_id, listing_id, qty, price, "escrow")
            )
            .status,
            200
        );

        // The relay derives roles and amount from the signed order, not from
        // request fields: every attempted substitution is refused.
        assert_eq!(
            post(
                &svc,
                "/escrow/open",
                &escrow_open(&buyer, &seller, &arbiter, order_id, nonce, amount - 1)
            )
            .status,
            400
        );
        assert_eq!(
            post(
                &svc,
                "/escrow/open",
                &escrow_open(&buyer, &outsider, &arbiter, order_id, nonce, amount)
            )
            .status,
            400
        );
        assert_eq!(
            post(
                &svc,
                "/escrow/open",
                &escrow_open(&outsider, &seller, &arbiter, order_id, nonce, amount)
            )
            .status,
            400
        );

        let open = escrow_open(&buyer, &seller, &arbiter, order_id, nonce, amount);
        let rep = post(&svc, "/escrow/open", &open);
        assert_eq!(rep.status, 200);
        let session = &body(&rep)["session"];
        assert_eq!(session["stage"], "proposed");
        assert_eq!(session["amount"], amount);
        assert_eq!(session["currency"], "XMR");
        assert_eq!(post(&svc, "/escrow/open", &open).status, 400);

        // All three joins, then the final (round 3) commit with one shared
        // escrow address and transcript hash.
        let joins = [
            escrow_event(
                &seller,
                order_id,
                join_message(
                    &seller.verifying_key().to_bytes(),
                    day,
                    0,
                    &order_id,
                    &nonce,
                    1,
                    b"multisig-seller",
                )
                .unwrap(),
            ),
            escrow_event(
                &arbiter,
                order_id,
                join_message(
                    &arbiter.verifying_key().to_bytes(),
                    day,
                    0,
                    &order_id,
                    &nonce,
                    2,
                    b"multisig-arbiter",
                )
                .unwrap(),
            ),
            escrow_event(
                &buyer,
                order_id,
                join_message(
                    &buyer.verifying_key().to_bytes(),
                    day,
                    1,
                    &order_id,
                    &nonce,
                    0,
                    b"multisig-buyer",
                )
                .unwrap(),
            ),
        ];
        for event in &joins {
            assert_eq!(post(&svc, "/escrow/event", event).status, 200);
        }
        let address = b"5StagenetEscrowAddress";
        let transcript_hash = escrow_format::setup_transcript_hash(&order_id, &nonce, address);
        let commits = [(&seller, 1u64), (&arbiter, 1u64), (&buyer, 2u64)];
        for (key, seq) in commits {
            let event = escrow_event(
                key,
                order_id,
                commit_message(
                    &key.verifying_key().to_bytes(),
                    day,
                    seq,
                    &order_id,
                    &nonce,
                    3,
                    address,
                    &transcript_hash,
                )
                .unwrap(),
            );
            assert_eq!(post(&svc, "/escrow/event", &event).status, 200);
        }
        assert_eq!(
            body(&get(&svc, &escrow_path(&buyer, Some(order_id))))["session"]["stage"],
            "setup"
        );

        // Only the buyer may post funding, and it must match frozen terms.
        let bad_funding = escrow_event(
            &arbiter,
            order_id,
            funded_message(
                &arbiter.verifying_key().to_bytes(),
                day,
                0,
                &order_id,
                &nonce,
                &[0x62; 32],
                amount,
                b"fake-proof",
            )
            .unwrap(),
        );
        assert_eq!(post(&svc, "/escrow/event", &bad_funding).status, 400);
        let funded = escrow_event(
            &buyer,
            order_id,
            funded_message(
                &buyer.verifying_key().to_bytes(),
                day,
                3,
                &order_id,
                &nonce,
                &[0x62; 32],
                amount,
                b"stagenet-tx-proof",
            )
            .unwrap(),
        );
        assert_eq!(post(&svc, "/escrow/event", &funded).status, 200);

        let payout = b"5SellerStagenetPayout";
        let inputs_hash = [0x63; 32];
        let txset_hash = [0x64; 32];
        let unsigned_release = release_message(
            &seller.verifying_key().to_bytes(),
            day,
            2,
            &order_id,
            &nonce,
            payout,
            amount,
            &inputs_hash,
            &txset_hash,
        )
        .unwrap();
        let signed_release = sign_message(unsigned_release, &seller);
        assert_eq!(
            post(
                &svc,
                "/escrow/event",
                &serde_json::json!({
                    "order": hex::encode(order_id),
                    "envelope": hex::encode(&signed_release),
                })
            )
            .status,
            200
        );
        let approve = escrow_event(
            &buyer,
            order_id,
            approve_message(
                &buyer.verifying_key().to_bytes(),
                day,
                4,
                &order_id,
                &nonce,
                &digest(&signed_release),
                0,
            )
            .unwrap(),
        );
        assert_eq!(post(&svc, "/escrow/event", &approve).status, 200);
        let submitted = escrow_event(
            &seller,
            order_id,
            submitted_message(
                &seller.verifying_key().to_bytes(),
                day,
                3,
                &order_id,
                &nonce,
                &[0x65; 32],
                0,
            )
            .unwrap(),
        );
        assert_eq!(post(&svc, "/escrow/event", &submitted).status, 200);

        let rep = get(&svc, &escrow_path(&buyer, Some(order_id)));
        assert_eq!(rep.status, 200);
        let b = body(&rep);
        assert_eq!(b["session"]["stage"], "released");
        assert_eq!(b["events"].as_array().unwrap().len(), 11);
        assert_eq!(b["events"][0]["domain"], "fly-escrow-v1/open");
        assert_eq!(post(&svc, "/escrow/event", &submitted).status, 400);
        assert_eq!(
            get(&svc, &escrow_path(&outsider, Some(order_id))).status,
            404
        );
        let rep = get(&svc, &escrow_path(&arbiter, None));
        assert_eq!(rep.status, 200);
        assert_eq!(body(&rep)["sessions"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn escrow_open_refuses_a_closed_order() {
        let svc = test_service();
        let seller = SigningKey::from_bytes(&[41u8; 32]);
        let buyer = SigningKey::from_bytes(&[42u8; 32]);
        let arbiter = SigningKey::from_bytes(&[43u8; 32]);
        let listing_id = [0x57; 16];
        let order_id = [0x58; 16];
        let nonce = [0x59; 16];
        let price = 1_000_000_000_000u64;
        let amount = price;

        assert_eq!(
            post(
                &svc,
                "/listing",
                &listing_currency(&seller, listing_id, 1, price, 2, "Ore", "XMR item", "XMR")
            )
            .status,
            200
        );
        assert_eq!(
            post(
                &svc,
                "/order",
                &order(&buyer, order_id, listing_id, 1, price, "closed")
            )
            .status,
            200
        );
        assert_eq!(
            post(
                &svc,
                &format!("/order/{}/status", hex::encode(order_id)),
                &status_update(&buyer, order_id, 4, "changed mind")
            )
            .status,
            200
        );
        assert_eq!(
            post(
                &svc,
                "/escrow/open",
                &escrow_open(&buyer, &seller, &arbiter, order_id, nonce, amount)
            )
            .status,
            400
        );
        assert_eq!(get(&svc, &escrow_path(&buyer, Some(order_id))).status, 404);
    }

    #[test]
    fn root_describes_the_service() {
        let svc = test_service();
        let rep = get(&svc, "/");
        assert_eq!(rep.status, 200);
        assert_eq!(body(&rep)["service"], "nysiris-shop");

        let mut headers = HashMap::new();
        headers.insert("accept".to_string(), "text/html".to_string());
        let req = nym_hidden_service::Request::new("GET", "/", headers, &[]).unwrap();
        let rep = Response::from_json(&dispatch(&svc, req.to_json().as_bytes())).unwrap();
        let text = String::from_utf8(rep.body().unwrap()).unwrap();
        assert!(text.contains("<h1>nysiris-shop</h1>"));
        assert!(text.contains("<h2>Browse &amp; sell</h2>"));
        assert!(text.contains("<h2>Orders</h2>"));
        assert!(text.contains("<h2>Reputation</h2>"));
        assert!(text.contains("<h2>Escrow relay (stagenet reference)</h2>"));
        assert!(text.contains("/escrow/event"));
        assert!(text.contains("POST /order"));
        assert!(text.contains("POST /review"));
        assert!(text.contains("Prices are integer minor units (100 = 1 major unit)"));
    }

    #[test]
    fn listing_create_update_browse_delete() {
        let svc = test_service();
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let id = [0xab; 16];

        assert_eq!(
            post(
                &svc,
                "/listing",
                &listing(&sk, id, 1, 1_25, 5, "Lamp", "Warm")
            )
            .status,
            200
        );

        let rep = get(&svc, "/listings?offset=0&limit=10");
        let b = body(&rep);
        assert_eq!(b["listings"].as_array().unwrap().len(), 1);
        assert_eq!(b["listings"][0]["price"], 125);
        assert_eq!(b["listings"][0]["currency"], "USD");

        // Update needs a higher version; the old one is refused.
        assert_eq!(
            post(
                &svc,
                "/listing",
                &listing(&sk, id, 1, 0, 99, "Lamp", "Warm")
            )
            .status,
            400
        );
        assert_eq!(
            post(
                &svc,
                "/listing",
                &listing(&sk, id, 2, 1_50, 3, "Lamp", "Warm")
            )
            .status,
            200
        );
        let rep = get(&svc, &format!("/listing/{}", hex::encode(id)));
        assert_eq!(body(&rep)["version"], 2);
        assert_eq!(body(&rep)["stock"], 3);

        // A tampered field no longer verifies.
        let mut evil = listing(&sk, id, 3, 0, 1, "Lamp", "Warm");
        evil["price"] = serde_json::json!(1);
        assert_eq!(post(&svc, "/listing", &evil).status, 400);

        // Only the owner can delete.
        let other = SigningKey::from_bytes(&[8u8; 32]);
        let mut del = serde_json::json!({
            "seller": hex::encode(other.verifying_key().to_bytes()),
            "day": sig::current_day(),
        });
        let msg =
            sig::listing_delete_message(&other.verifying_key().to_bytes(), &id, sig::current_day());
        del["sig"] = serde_json::json!(hex::encode(other.sign(&msg).to_bytes()));
        assert_eq!(
            post(&svc, &format!("/listing/{}/delete", hex::encode(id)), &del).status,
            404
        );

        let seller = sk.verifying_key().to_bytes();
        let msg = sig::listing_delete_message(&seller, &id, sig::current_day());
        let del = serde_json::json!({
            "seller": hex::encode(seller), "day": sig::current_day(),
            "sig": hex::encode(sk.sign(&msg).to_bytes()),
        });
        assert_eq!(
            post(&svc, &format!("/listing/{}/delete", hex::encode(id)), &del).status,
            200
        );
        assert_eq!(
            body(&get(&svc, "/listings?offset=0&limit=10"))["listings"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        // Still resolvable for past orders, now inactive.
        assert_eq!(
            body(&get(&svc, &format!("/listing/{}", hex::encode(id))))["active"],
            false
        );
    }

    #[test]
    fn order_lifecycle_moves_stock() {
        let svc = test_service();
        let seller = SigningKey::from_bytes(&[7u8; 32]);
        let buyer = SigningKey::from_bytes(&[8u8; 32]);
        let listing_id = [1u8; 16];
        let order_id = [2u8; 16];
        assert_eq!(
            post(
                &svc,
                "/listing",
                &listing(&seller, listing_id, 1, 5_00, 5, "Lamp", "Warm"),
            )
            .status,
            200
        );
        // Self-purchases cannot bootstrap a 5-star self-review.
        assert_eq!(
            post(
                &svc,
                "/order",
                &order(&seller, [5u8; 16], listing_id, 1, 5_00, "")
            )
            .status,
            400
        );

        let rep = post(
            &svc,
            "/order",
            &order(&buyer, order_id, listing_id, 3, 5_00, "hello"),
        );
        assert_eq!(rep.status, 200);
        let held = body(&get(&svc, &format!("/listing/{}", hex::encode(listing_id))));
        // Signed stock is untouched, so the signature still verifies.
        assert_eq!(held["stock"], 5);
        assert_eq!(held["available"], 2);
        let seller_bytes = seller.verifying_key().to_bytes();
        let msg = sig::listing_message(
            &seller_bytes,
            held["day"].as_u64().unwrap(),
            &listing_id,
            1,
            5_00,
            5,
            b"USD",
            "Lamp",
            "Warm",
        );
        let stored_sig = sig::parse_sig(held["sig"].as_str().unwrap()).unwrap();
        assert!(sig::verify(&seller_bytes, &msg, &stored_sig).is_ok());

        // Oversell refused, availability unchanged. The order is properly
        // signed; only the remaining quantity (2) makes it invalid.
        assert_eq!(
            post(
                &svc,
                "/order",
                &order(&buyer, [3u8; 16], listing_id, 3, 5_00, "")
            )
            .status,
            400
        );

        // Seller accepts, buyer cancels: availability returns.
        assert_eq!(
            post(
                &svc,
                &format!("/order/{}/status", hex::encode(order_id)),
                &status_update(&seller, order_id, 1, "ok")
            )
            .status,
            200
        );
        assert_eq!(
            post(
                &svc,
                &format!("/order/{}/status", hex::encode(order_id)),
                &status_update(&buyer, order_id, 4, "changed mind")
            )
            .status,
            200
        );
        let o = body(&get(&svc, &orders_path(&buyer)));
        let ev = o["orders"][0]["status_events"].as_array().unwrap();
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0]["from_code"].as_u64(), Some(0));
        assert_eq!(ev[0]["status_code"].as_u64(), Some(1));
        assert_eq!(ev[1]["from_code"].as_u64(), Some(1));
        assert_eq!(ev[1]["status_code"].as_u64(), Some(4));
        assert_eq!(
            ev[1]["actor"].as_str().unwrap(),
            hex::encode(buyer.verifying_key().to_bytes())
        );
        let actor = sig::parse_pubkey(ev[1]["actor"].as_str().unwrap()).unwrap();
        let proof = sig::parse_sig(ev[1]["sig"].as_str().unwrap()).unwrap();
        let proof_msg = sig::order_status_message(
            &actor,
            ev[1]["day"].as_u64().unwrap(),
            &order_id,
            ev[1]["status_code"].as_u64().unwrap() as u8,
            ev[1]["note"].as_str().unwrap(),
        );
        assert!(sig::verify(&actor, &proof_msg, &proof).is_ok());
        assert_eq!(
            body(&get(&svc, &format!("/listing/{}", hex::encode(listing_id))))["available"],
            5
        );

        // Fresh order fulfilled keeps the units consumed.
        let order2 = [4u8; 16];
        assert_eq!(
            post(
                &svc,
                "/order",
                &order(&buyer, order2, listing_id, 2, 5_00, "")
            )
            .status,
            200
        );
        assert_eq!(
            post(
                &svc,
                &format!("/order/{}/status", hex::encode(order2)),
                &status_update(&seller, order2, 1, "")
            )
            .status,
            200
        );
        assert_eq!(
            post(
                &svc,
                &format!("/order/{}/status", hex::encode(order2)),
                &status_update(&seller, order2, 2, "")
            )
            .status,
            200
        );
        assert_eq!(
            body(&get(&svc, &format!("/listing/{}", hex::encode(listing_id))))["available"],
            3
        );

        // Illegal move is refused.
        assert_eq!(
            post(
                &svc,
                &format!("/order/{}/status", hex::encode(order2)),
                &status_update(&buyer, order2, 4, "")
            )
            .status,
            400
        );
    }

    #[test]
    fn orders_read_is_private_to_the_parties() {
        let svc = test_service();
        let seller = SigningKey::from_bytes(&[7u8; 32]);
        let buyer = SigningKey::from_bytes(&[8u8; 32]);
        let stranger = SigningKey::from_bytes(&[9u8; 32]);
        let listing_id = [1u8; 16];
        let order_id = [2u8; 16];
        post(
            &svc,
            "/listing",
            &listing(&seller, listing_id, 1, 1_00, 5, "Lamp", "Warm"),
        );
        post(
            &svc,
            "/order",
            &order(&buyer, order_id, listing_id, 1, 1_00, ""),
        );

        // No signature: refused.
        assert_eq!(
            get(
                &svc,
                &format!(
                    "/orders?for={}",
                    hex::encode(buyer.verifying_key().to_bytes())
                )
            )
            .status,
            401
        );

        // Buyer and seller each see it; a stranger sees an empty list.
        let b = body(&get(&svc, &orders_path(&buyer)));
        assert_eq!(b["orders"].as_array().unwrap().len(), 1);
        assert_eq!(b["orders"][0]["id"], hex::encode(order_id));
        assert_eq!(b["orders"][0]["status"], "reserved");
        let s = body(&get(&svc, &orders_path(&seller)));
        assert_eq!(s["orders"].as_array().unwrap().len(), 1);
        assert!(body(&get(&svc, &orders_path(&stranger)))["orders"]
            .as_array()
            .unwrap()
            .is_empty());

        // A signature for one key cannot read another key's list.
        let who = stranger.verifying_key().to_bytes();
        let day = sig::current_day();
        let sig = stranger.sign(&sig::orders_read_message(&who, day));
        let path = format!(
            "/orders?for={}&day={}&sig={}",
            hex::encode(buyer.verifying_key().to_bytes()),
            day,
            hex::encode(sig.to_bytes())
        );
        assert_eq!(get(&svc, &path).status, 401);
    }

    #[test]
    fn order_messages_are_participant_only() {
        let svc = test_service();
        let seller = SigningKey::from_bytes(&[7u8; 32]);
        let buyer = SigningKey::from_bytes(&[8u8; 32]);
        let stranger = SigningKey::from_bytes(&[9u8; 32]);
        let listing_id = [1u8; 16];
        let order_id = [2u8; 16];
        post(
            &svc,
            "/listing",
            &listing(&seller, listing_id, 1, 1_00, 5, "Lamp", "Warm"),
        );
        post(
            &svc,
            "/order",
            &order(&buyer, order_id, listing_id, 1, 1_00, ""),
        );

        let path = format!("/order/{}/message", hex::encode(order_id));
        assert_eq!(
            post(&svc, &path, &message(&buyer, order_id, "when do you ship?")).status,
            200
        );
        assert_eq!(
            post(&svc, &path, &message(&seller, order_id, "tomorrow")).status,
            200
        );
        assert_eq!(
            post(&svc, &path, &message(&stranger, order_id, "spam")).status,
            403
        );

        let b = body(&get(&svc, &orders_path(&buyer)));
        let messages = b["orders"][0]["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["body"], "when do you ship?");
        assert_eq!(messages[1]["body"], "tomorrow");
        assert_eq!(b["orders"][0]["messages_total"], 2);
        assert!(b["orders"][0]["messages_next_offset"].is_null());

        // Explicit pages walk backwards from the newest message. A page of
        // one returns the latest row first, then older rows via its cursor.
        let latest = body(&get(&svc, &messages_path(&buyer, order_id, 0, 1)));
        assert_eq!(latest["total"], 2);
        assert_eq!(latest["next_offset"], 1);
        assert_eq!(latest["messages"][0]["body"], "tomorrow");
        let older = body(&get(&svc, &messages_path(&seller, order_id, 1, 1)));
        assert_eq!(older["total"], 2);
        assert!(older["next_offset"].is_null());
        assert_eq!(older["messages"][0]["body"], "when do you ship?");
        assert_eq!(
            get(&svc, &messages_path(&stranger, order_id, 0, 10)).status,
            403
        );
    }

    #[test]
    fn reviews_need_fulfilment_buyer_and_uniqueness() {
        let svc = test_service();
        let seller = SigningKey::from_bytes(&[7u8; 32]);
        let buyer = SigningKey::from_bytes(&[8u8; 32]);
        let listing_id = [1u8; 16];
        let order_id = [2u8; 16];
        post(
            &svc,
            "/listing",
            &listing(&seller, listing_id, 1, 1_00, 5, "Lamp", "Warm"),
        );
        post(
            &svc,
            "/order",
            &order(&buyer, order_id, listing_id, 1, 1_00, ""),
        );

        // Not fulfilled yet.
        assert_eq!(
            post(
                &svc,
                "/review",
                &review(&buyer, order_id, &seller, 5, "great")
            )
            .status,
            400
        );
        post(
            &svc,
            &format!("/order/{}/status", hex::encode(order_id)),
            &status_update(&seller, order_id, 1, ""),
        );
        post(
            &svc,
            &format!("/order/{}/status", hex::encode(order_id)),
            &status_update(&seller, order_id, 2, ""),
        );

        // Seller can't review; buyer can, once.
        assert_eq!(
            post(
                &svc,
                "/review",
                &review(&seller, order_id, &seller, 5, "great")
            )
            .status,
            400
        );
        assert_eq!(
            post(
                &svc,
                "/review",
                &review(&buyer, order_id, &seller, 4, "good")
            )
            .status,
            200
        );
        assert_eq!(
            post(
                &svc,
                "/review",
                &review(&buyer, order_id, &seller, 5, "again")
            )
            .status,
            400
        );

        let seller_hex = hex::encode(seller.verifying_key().to_bytes());
        let b = body(&get(&svc, &format!("/reviews/{seller_hex}")));
        assert_eq!(b["reviews"].as_array().unwrap().len(), 1);
        assert_eq!(b["summary"]["count"], 1);
        assert_eq!(b["summary"]["sum"], 4);
        assert_eq!(b["summary"]["average_x100"], 400);
        // It also rides on the private order view.
        let o = body(&get(&svc, &orders_path(&buyer)));
        assert_eq!(o["orders"][0]["review"]["rating"], 4);
    }

    #[test]
    fn pow_and_rate_gate_listing_writes() {
        use portal_reputation::rate::RatePolicy;
        let svc = ShopService::with_limits(
            Store::open_in_memory().unwrap(),
            4,
            RatePolicy { max_per_day: 1 },
        );
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let seller = sk.verifying_key().to_bytes();

        let mut first = listing(&sk, [1u8; 16], 1, 1_00, 1, "Lamp", "Warm");
        assert_eq!(post(&svc, "/listing", &first).status, 400);

        let preimage = pow::listing_pow_preimage(&[1u8; 16], 1, 1_00, 1, b"USD", "Lamp", "Warm");
        let hash = portal_reputation::pow::payload_hash(&preimage);
        let proof = portal_reputation::pow::prove(&seller, &hash, 4, 0, 10_000_000).unwrap();
        first["pow"] = serde_json::json!({"nonce": proof.nonce, "bits": proof.bits});
        assert_eq!(post(&svc, "/listing", &first).status, 200);

        // Daily budget is spent: next write is 429 even with valid PoW.
        let mut second = listing(&sk, [2u8; 16], 1, 1_00, 1, "Chair", "Oak");
        let preimage = pow::listing_pow_preimage(&[2u8; 16], 1, 1_00, 1, b"USD", "Chair", "Oak");
        let hash = portal_reputation::pow::payload_hash(&preimage);
        let proof = portal_reputation::pow::prove(&seller, &hash, 4, 0, 10_000_000).unwrap();
        second["pow"] = serde_json::json!({"nonce": proof.nonce, "bits": proof.bits});
        assert_eq!(post(&svc, "/listing", &second).status, 429);
    }

    #[test]
    fn rejected_writes_refund_the_rate_budget() {
        use portal_reputation::rate::RatePolicy;
        let svc = ShopService::with_limits(
            Store::open_in_memory().unwrap(),
            4,
            RatePolicy { max_per_day: 2 },
        );
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let seller = sk.verifying_key().to_bytes();

        let mut first = listing(&sk, [1u8; 16], 1, 1_00, 1, "Lamp", "Warm");
        let preimage = pow::listing_pow_preimage(&[1u8; 16], 1, 1_00, 1, b"USD", "Lamp", "Warm");
        let hash = portal_reputation::pow::payload_hash(&preimage);
        let proof = portal_reputation::pow::prove(&seller, &hash, 4, 0, 10_000_000).unwrap();
        first["pow"] = serde_json::json!({"nonce": proof.nonce, "bits": proof.bits});
        assert_eq!(post(&svc, "/listing", &first).status, 200);

        // Replaying the public signed write passes signature+PoW but fails in
        // the store (duplicate/stale). The slot must be returned, or anyone
        // could drain the seller's budget with one captured request.
        assert_eq!(post(&svc, "/listing", &first).status, 400);

        let mut second = listing(&sk, [2u8; 16], 1, 1_00, 1, "Chair", "Oak");
        let preimage = pow::listing_pow_preimage(&[2u8; 16], 1, 1_00, 1, b"USD", "Chair", "Oak");
        let hash = portal_reputation::pow::payload_hash(&preimage);
        let proof = portal_reputation::pow::prove(&seller, &hash, 4, 0, 10_000_000).unwrap();
        second["pow"] = serde_json::json!({"nonce": proof.nonce, "bits": proof.bits});
        assert_eq!(post(&svc, "/listing", &second).status, 200);
    }

    #[test]
    fn invalid_listings_are_refused() {
        let svc = test_service();
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let id = [1u8; 16];

        // Bad currency/version/stock/text never reaches storage.
        let mut bad = listing(&sk, id, 1, 1_00, 1, "Lamp", "Warm");
        bad["currency"] = serde_json::json!("usd");
        assert_eq!(post(&svc, "/listing", &bad).status, 400);

        let mut bad = listing(&sk, id, 1, 1_00, 1, "Lamp", "Warm");
        bad["version"] = serde_json::json!(0);
        assert_eq!(post(&svc, "/listing", &bad).status, 400);

        let bad = listing(&sk, id, 1, 1_00, 1, "Lamp\0hidden", "Warm");
        assert_eq!(post(&svc, "/listing", &bad).status, 400);

        let bad = listing(&sk, id, 1, 1_00, 1, &"x".repeat(81), "Warm");
        assert_eq!(post(&svc, "/listing", &bad).status, 400);

        // Stale day.
        let seller = sk.verifying_key().to_bytes();
        let old_day = sig::current_day().saturating_sub(9);
        let msg = sig::listing_message(&seller, old_day, &id, 1, 1_00, 1, b"USD", "Lamp", "Warm");
        let mut stale = listing(&sk, id, 1, 1_00, 1, "Lamp", "Warm");
        stale["day"] = serde_json::json!(old_day);
        stale["sig"] = serde_json::json!(hex::encode(sk.sign(&msg).to_bytes()));
        assert_eq!(post(&svc, "/listing", &stale).status, 400);
    }

    #[test]
    fn missing_numbers_fail_loudly_and_free_listings_are_orderable() {
        let svc = test_service();
        let seller = SigningKey::from_bytes(&[2u8; 32]);
        let buyer = SigningKey::from_bytes(&[4u8; 32]);
        let listing_id = [1u8; 16];
        let free = listing(&seller, listing_id, 1, 0, 3, "Sample", "Free");
        assert_eq!(post(&svc, "/listing", &free).status, 200);

        let mut no_price = free.clone();
        no_price.as_object_mut().unwrap().remove("price");
        let rep = post(&svc, "/listing", &no_price);
        assert_eq!(rep.status, 400);
        assert_eq!(
            rep.error.as_deref(),
            Some("price must be an unsigned integer")
        );

        // A zero price is a real free listing, not a missing field.
        assert_eq!(
            post(
                &svc,
                "/order",
                &order(&buyer, [7u8; 16], listing_id, 1, 0, "free")
            )
            .status,
            200
        );

        let mut no_qty = order(&buyer, [8u8; 16], listing_id, 1, 0, "free");
        no_qty.as_object_mut().unwrap().remove("qty");
        let rep = post(&svc, "/order", &no_qty);
        assert_eq!(rep.status, 400);
        assert_eq!(
            rep.error.as_deref(),
            Some("qty must be an unsigned integer")
        );
    }
}
