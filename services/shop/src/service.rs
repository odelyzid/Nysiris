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
//! POST /review                          -> {ok}
//! GET  /reviews/<hex64>?offset=&limit=  -> {reviews:[...], summary}
//! ```
//!
//! Orders are private: `GET /orders` needs a signature from the buyer or
//! seller key, so a public key cannot be used to enumerate purchases.
//! Reviews are public but raw and signed; the aggregate is computed by
//! clients, never stored.

use std::sync::Mutex;

use nym_hidden_service::{HiddenService, Request, Response};
use provider_runtime::route::{json_body, parse_query};
use provider_runtime::Router;
use shop_format::{limits, pow, review, sig, status::OrderStatus};

use crate::store::{Order, OrderMessage, Review, StatusEvent, Store};

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
            "POST /review",
            "GET /reviews/<hex64>?offset=<n>&limit=<n>",
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
<li><code>POST /order/&lt;id&gt;/message</code> — participant-only thread for this order</li>\
</ul>\
<h2>Reputation</h2>\
<ul>\
<li><code>POST /review</code> — one buyer-signed review per fulfilled order</li>\
<li><code>GET /reviews/&lt;seller&gt;?offset=&lt;n&gt;&amp;limit=&lt;n&gt;</code> — raw signed reviews; clients aggregate locally</li>\
</ul>\
<p>No accounts, no carts, no payment processing, no trusted server score. \
Review responses include a convenience aggregate, but clients re-verify every \
signed row and recompute reputation themselves. Prices are integer minor units; \
shipping details never belong on this service.</p>\
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
    messages: &[OrderMessage],
    review: Option<&Review>,
    events: &[StatusEvent],
) -> serde_json::Value {
    let status = OrderStatus::from_code(o.status)
        .map(|s| s.as_str())
        .unwrap_or("unknown");
    serde_json::json!({
        "id": o.id_hex, "listing": o.listing_hex, "buyer": o.buyer_hex,
        "seller": o.seller_hex, "qty": o.qty, "note": o.note,
        "status": status, "status_code": o.status, "day": o.day, "sig": o.sig_hex,
        "status_events": events.iter().map(status_event_json).collect::<Vec<_>>(),
        "messages": messages.iter().map(message_json).collect::<Vec<_>>(),
        "review": review.map(review_json),
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

fn field_id16(v: &serde_json::Value, key: &str) -> Result<[u8; 16], Response> {
    let s = v
        .get(key)
        .and_then(|x| x.as_str())
        .ok_or_else(|| Response::error(400, format!("missing {key}")))?;
    let bytes =
        hex::decode(s.trim()).map_err(|_| Response::error(400, format!("{key} must be hex")))?;
    if bytes.len() != 16 {
        return Err(Response::error(400, format!("{key} must be a 16-byte id")));
    }
    let mut out = [0u8; 16];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn field_u64(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

fn field_u32(v: &serde_json::Value, key: &str) -> u32 {
    v.get(key)
        .and_then(|x| x.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
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
                    Response::ok(200, "text/html", DESCRIPTOR_HTML.as_bytes())
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
                let day = field_u64(&v, "day");
                if let Err(e) = fresh_day(day) {
                    return e;
                }
                let version = field_u64(&v, "version");
                if version == 0 {
                    return Response::error(400, "version must be positive");
                }
                let price = field_u64(&v, "price");
                let stock = field_u32(&v, "stock");
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
                let day = field_u64(&v, "day");
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
                let day = field_u64(&v, "day");
                if let Err(e) = fresh_day(day) {
                    return e;
                }
                let qty = field_u32(&v, "qty");
                if qty == 0 || qty > limits::MAX_ORDER_QTY {
                    return Response::error(400, "qty must be 1..=1000");
                }
                let note = field_str(&v, "note");
                if let Err(e) = check_text(note, "note", None, Some(limits::MAX_NOTE_BYTES)) {
                    return e;
                }
                if sig::verify(
                    &buyer,
                    &sig::order_message(&buyer, day, &listing, &id, qty, note),
                    &sig,
                )
                .is_err()
                {
                    return Response::error(400, "signature verification failed");
                }
                if let Err(e) = self.gate(
                    &buyer,
                    &pow::order_pow_preimage(&listing, &id, qty, note),
                    &v,
                ) {
                    return e;
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let result =
                    store.insert_order(&id, &listing, &buyer, day, qty, note, &sig.to_bytes());
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
                let who = match query.get("for").map(|s| sig::parse_pubkey(s)) {
                    Some(Ok(k)) => k,
                    _ => return Response::error(400, "missing ?for=<pubkey>"),
                };
                let signature = match query.get("sig").map(|s| sig::parse_sig(s)) {
                    Some(Ok(s)) => s,
                    _ => {
                        return Response::error(
                            401,
                            "order list requires a signature (proof of possession)",
                        )
                    }
                };
                let day = match query.get("day").and_then(|d| d.trim().parse::<u64>().ok()) {
                    Some(d) => d,
                    None => return Response::error(400, "missing ?day=<n>"),
                };
                if day.abs_diff(sig::current_day()) > 2 {
                    return Response::error(
                        401,
                        "stale order read (day outside the freshness window)",
                    );
                }
                if sig::verify(&who, &sig::orders_read_message(&who, day), &signature).is_err() {
                    return Response::error(401, "order read signature does not match the key");
                }
                let store = match self.lock() {
                    Ok(s) => s,
                    Err(e) => return e,
                };
                let orders = match store.orders_for(&who) {
                    Ok(o) => o,
                    Err(e) => return Response::error(500, e),
                };
                let mut items = Vec::with_capacity(orders.len());
                for order in &orders {
                    let id_bytes = match hex::decode(&order.id_hex) {
                        Ok(b) if b.len() == 16 => b,
                        _ => return Response::error(500, "corrupt order id"),
                    };
                    let mut id = [0u8; 16];
                    id.copy_from_slice(&id_bytes);
                    let messages = match store.messages_for(&id) {
                        Ok(m) => m,
                        Err(e) => return Response::error(500, e),
                    };
                    let review = match store.review_for_order(&id) {
                        Ok(r) => r,
                        Err(e) => return Response::error(500, e),
                    };
                    let events = match store.status_events_for(&id) {
                        Ok(v) => v,
                        Err(e) => return Response::error(500, e),
                    };
                    items.push(order_json(order, &messages, review.as_ref(), &events));
                }
                Response::ok(
                    200,
                    "application/json",
                    &json_body(&serde_json::json!({"orders": items})),
                )
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
                let day = field_u64(&v, "day");
                if let Err(e) = fresh_day(day) {
                    return e;
                }
                let code = v.get("status").and_then(|s| s.as_u64()).unwrap_or(0);
                let next = match u8::try_from(code).ok().and_then(OrderStatus::from_code) {
                    Some(s) => s,
                    None => return Response::error(400, "status must be 1..=4"),
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
                let day = field_u64(&v, "day");
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
                let day = field_u64(&v, "day");
                if let Err(e) = fresh_day(day) {
                    return e;
                }
                let rating = v.get("rating").and_then(|r| r.as_u64()).unwrap_or(0);
                let rating = u8::try_from(rating).unwrap_or(0);
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
            _ => Response::error(404, "unknown route"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
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
        let seller = sk.verifying_key().to_bytes();
        let day = sig::current_day();
        let currency = b"USD";
        let msg = sig::listing_message(
            &seller,
            day,
            &id,
            version,
            price,
            stock,
            currency,
            title,
            description,
        );
        serde_json::json!({
            "seller": hex::encode(seller), "day": day, "id": hex::encode(id),
            "version": version, "price": price, "stock": stock, "currency": "USD",
            "title": title, "description": description,
            "sig": hex::encode(sk.sign(&msg).to_bytes()),
        })
    }

    fn order(
        sk: &SigningKey,
        id: [u8; 16],
        listing: [u8; 16],
        qty: u32,
        note: &str,
    ) -> serde_json::Value {
        let buyer = sk.verifying_key().to_bytes();
        let day = sig::current_day();
        let msg = sig::order_message(&buyer, day, &listing, &id, qty, note);
        serde_json::json!({
            "buyer": hex::encode(buyer), "day": day, "id": hex::encode(id),
            "listing": hex::encode(listing), "qty": qty, "note": note,
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
        assert!(text.contains("POST /order"));
        assert!(text.contains("POST /review"));
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
                &order(&seller, [5u8; 16], listing_id, 1, "")
            )
            .status,
            400
        );

        let rep = post(
            &svc,
            "/order",
            &order(&buyer, order_id, listing_id, 3, "hello"),
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
            post(&svc, "/order", &order(&buyer, [3u8; 16], listing_id, 3, "")).status,
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
            post(&svc, "/order", &order(&buyer, order2, listing_id, 2, "")).status,
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
        post(&svc, "/order", &order(&buyer, order_id, listing_id, 1, ""));

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
        post(&svc, "/order", &order(&buyer, order_id, listing_id, 1, ""));

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
        post(&svc, "/order", &order(&buyer, order_id, listing_id, 1, ""));

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
}
