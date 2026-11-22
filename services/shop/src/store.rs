//! Metadata-minimal SQLite store for nysiris-shop.
//!
//! What is stored per row — and, more importantly, what is NOT:
//!
//! * listings: random 16-byte id, seller pubkey, coarse day, monotonic
//!   `version`, integer price (minor units), stock, currency code, title,
//!   description, signature. No IPs, Nym addresses, precise timestamps, or
//!   view counters.
//! * orders: random 16-byte id, listing id, buyer pubkey, seller pubkey,
//!   quantity, the signed price/version snapshot, short public note, state,
//!   signature, creation time (ordering only). Shipping data never belongs
//!   here — trade addresses over the social DM dead-drop.
//! * order_status_events: every signed transition (from/to state, actor,
//!   coarse day, note, signature). Clients replay the chain from `reserved`
//!   to verify the reported state; the provider cannot forge it.
//! * order_messages: order id, author pubkey, coarse day, body, signature.
//!   Bounded per thread and read in pages through signed,
//!   participant-scoped routes.
//! * reviews: one per fulfilled order, buyer-signed, rating + body. No
//!   aggregate score is stored: clients re-verify signatures and compute the
//!   summary locally (docs/16-shop.md §16.5).
//!
//! SQLite is embedded (no network listener), single file (backup = copy one
//! file), WAL mode. Filesystem permissions (0600) + volume encryption cover
//! data at rest; see `docs/09-social.md` §9.1 for the same reasoning.

use rusqlite::{params, Connection, OptionalExtension};
use shop_format::limits::{
    DEFAULT_MESSAGES_PAGE, MAX_DESCRIPTION_CHARS, MAX_LISTINGS_PAGE, MAX_MESSAGES_PAGE,
    MAX_MESSAGE_BYTES, MAX_NOTE_BYTES, MAX_ORDER_MESSAGES, MAX_REVIEW_BYTES, MAX_TITLE_CHARS,
};
use shop_format::status::{ActorRole, OrderStatus};
use std::collections::HashMap;

pub struct Listing {
    pub id_hex: String,
    pub seller_hex: String,
    pub day: u64,
    pub version: u64,
    pub price: u64,
    /// Signed maximum stock. Immutable between versions: orders never rewrite
    /// the listing row, so the signature always covers exactly this value.
    pub stock: u32,
    /// Derived availability: `stock` minus units held by open/fulfilled
    /// orders. Never signed; computed from the order history on read.
    pub available: u32,
    pub currency: String,
    pub title: String,
    pub description: String,
    pub active: bool,
    pub sig_hex: String,
}

pub struct Order {
    pub id_hex: String,
    pub listing_hex: String,
    pub buyer_hex: String,
    pub seller_hex: String,
    pub qty: u32,
    /// Price minor units and listing version the buyer signed at reservation.
    pub price: u64,
    pub version: u64,
    pub note: String,
    pub status: u8,
    pub day: u64,
    pub sig_hex: String,
}

pub struct OrderMessage {
    pub author_hex: String,
    pub day: u64,
    pub body: String,
    pub sig_hex: String,
}

/// A bounded window of a thread. `offset` counts back from the newest message;
/// returned rows are chronological so the UI can render them in order.
pub struct MessagePage {
    pub messages: Vec<OrderMessage>,
    pub total: usize,
    pub next_offset: Option<usize>,
}

/// One order plus the signed rows needed to render it in a single `/orders`
/// response. Assembled with one query per table, not one query per order.
pub struct OrderDetail {
    pub order: Order,
    pub messages: MessagePage,
    pub review: Option<Review>,
    pub events: Vec<StatusEvent>,
}

/// One signed state transition. Stored so clients can replay the chain from
/// `reserved` and detect a provider that reports a state no party signed.
pub struct StatusEvent {
    pub from_code: u8,
    pub status_code: u8,
    pub actor_hex: String,
    pub day: u64,
    pub note: String,
    pub sig_hex: String,
}

pub struct Review {
    pub order_hex: String,
    pub seller_hex: String,
    pub author_hex: String,
    pub rating: u8,
    pub body: String,
    pub day: u64,
    pub sig_hex: String,
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        let store = Self { conn };
        store.init()?;
        store.restrict_permissions(path);
        Ok(store)
    }

    /// The DB and its WAL/SHM sidecars hold signed order and message history.
    /// Force owner-only permissions instead of trusting the caller's umask.
    fn restrict_permissions(&self, path: &std::path::Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::Permissions::from_mode(0o600);
            let mut wal = path.as_os_str().to_os_string();
            wal.push("-wal");
            let mut shm = path.as_os_str().to_os_string();
            shm.push("-shm");
            for candidate in [path, std::path::Path::new(&wal), std::path::Path::new(&shm)] {
                if candidate.exists() {
                    let _ = std::fs::set_permissions(candidate, mode.clone());
                }
            }
        }
        #[cfg(not(unix))]
        let _ = path;
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let store = Self { conn };
        store.init()?;
        Ok(store)
    }

    fn init(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=NORMAL;
                 CREATE TABLE IF NOT EXISTS listings(
                   id          BLOB PRIMARY KEY,
                   seller      BLOB NOT NULL,
                   day         INTEGER NOT NULL,
                   version     INTEGER NOT NULL,
                   price       INTEGER NOT NULL,
                   stock       INTEGER NOT NULL,
                   currency    TEXT NOT NULL,
                   title       TEXT NOT NULL,
                   description TEXT NOT NULL,
                   active      INTEGER NOT NULL,
                   sig         BLOB NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller);
                 CREATE INDEX IF NOT EXISTS idx_listings_browse ON listings(active, day);
                 CREATE TABLE IF NOT EXISTS orders(
                   id         BLOB PRIMARY KEY,
                   listing_id BLOB NOT NULL,
                   buyer      BLOB NOT NULL,
                   seller     BLOB NOT NULL,
                   qty        INTEGER NOT NULL,
                   note       TEXT NOT NULL,
                   status     INTEGER NOT NULL,
                   day        INTEGER NOT NULL,
                   created    INTEGER NOT NULL,
                   sig        BLOB NOT NULL,
                   price      INTEGER NOT NULL,
                   version    INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer);
                 CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller);
                 CREATE INDEX IF NOT EXISTS idx_orders_listing ON orders(listing_id);
                 CREATE TABLE IF NOT EXISTS order_messages(
                   seq      INTEGER PRIMARY KEY AUTOINCREMENT,
                   order_id BLOB NOT NULL,
                   author   BLOB NOT NULL,
                   day      INTEGER NOT NULL,
                   body     TEXT NOT NULL,
                   sig      BLOB NOT NULL,
                   created  INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_order_messages_order ON order_messages(order_id);
                 CREATE TABLE IF NOT EXISTS order_status_events(
                   seq        INTEGER PRIMARY KEY AUTOINCREMENT,
                   order_id   BLOB NOT NULL,
                   from_code  INTEGER NOT NULL,
                   status     INTEGER NOT NULL,
                   actor      BLOB NOT NULL,
                   day        INTEGER NOT NULL,
                   note       TEXT NOT NULL,
                   sig        BLOB NOT NULL,
                   created    INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_status_events_order ON order_status_events(order_id);
                 CREATE TABLE IF NOT EXISTS reviews(
                   order_id   BLOB PRIMARY KEY,
                   listing_id BLOB NOT NULL,
                   seller     BLOB NOT NULL,
                   author     BLOB NOT NULL,
                   rating     INTEGER NOT NULL,
                   body       TEXT NOT NULL,
                   day        INTEGER NOT NULL,
                   sig        BLOB NOT NULL,
                   created    INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_reviews_seller ON reviews(seller);",
            )
            .map_err(|e| e.to_string())?;
        // Databases created before order terms were frozen need the two new
        // columns. Existing rows get 0 and are displayed as "unknown terms".
        let mut stmt = self
            .conn
            .prepare("PRAGMA table_info(orders)")
            .map_err(|e| e.to_string())?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        if !columns.iter().any(|c| c == "price") {
            self.conn
                .execute_batch(
                    "ALTER TABLE orders ADD COLUMN price INTEGER NOT NULL DEFAULT 0;
                     ALTER TABLE orders ADD COLUMN version INTEGER NOT NULL DEFAULT 0;",
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn now_unix() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    // ---- listings ----

    /// Insert or update a listing. Versions are monotonic per id: an update
    /// must carry a strictly higher `version`, so a replay of an old signed
    /// listing cannot roll the price or stock back.
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_listing(
        &self,
        id: &[u8; 16],
        seller: &[u8; 32],
        day: u64,
        version: u64,
        price: u64,
        stock: u32,
        currency: &[u8; 3],
        title: &str,
        description: &str,
        sig: &[u8],
    ) -> Result<(), String> {
        if title.chars().count() > MAX_TITLE_CHARS {
            return Err("title too long".into());
        }
        if description.chars().count() > MAX_DESCRIPTION_CHARS {
            return Err("description too long".into());
        }
        // The version check and the upsert must be one transaction: two
        // writers racing on the same id could otherwise both accept version N.
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let existing: Option<(Vec<u8>, i64)> = tx
            .query_row(
                "SELECT seller,version FROM listings WHERE id=?",
                params![id.as_slice()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((owner, stored_version)) = existing {
            if owner.as_slice() != seller.as_slice() {
                return Err("listing id belongs to another seller".into());
            }
            if (version as i64) <= stored_version {
                return Err("stale listing version".into());
            }
        }
        tx.execute(
                "INSERT INTO listings(id,seller,day,version,price,stock,currency,title,description,active,sig)
                 VALUES(?,?,?,?,?,?,?,?,?,1,?)
                 ON CONFLICT(id) DO UPDATE SET
                   seller=excluded.seller, day=excluded.day, version=excluded.version,
                   price=excluded.price, stock=excluded.stock, currency=excluded.currency,
                   title=excluded.title, description=excluded.description,
                   active=1, sig=excluded.sig",
                params![
                    id.as_slice(),
                    seller.as_slice(),
                    day as i64,
                    version as i64,
                    price as i64,
                    stock as i64,
                    std::str::from_utf8(currency).map_err(|e| e.to_string())?,
                    title,
                    description,
                    sig
                ],
            )
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Soft-delete: the row stays so existing orders can still resolve it,
    /// but browse no longer lists it and new orders are refused.
    pub fn delete_listing(&self, seller: &[u8; 32], id: &[u8; 16]) -> Result<bool, String> {
        let n = self
            .conn
            .execute(
                "UPDATE listings SET active=0 WHERE id=? AND seller=? AND active=1",
                params![id.as_slice(), seller.as_slice()],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    fn listing_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Listing> {
        let id: Vec<u8> = row.get(0)?;
        let seller: Vec<u8> = row.get(1)?;
        let sig: Vec<u8> = row.get(11)?;
        Ok(Listing {
            id_hex: hex::encode(id),
            seller_hex: hex::encode(seller),
            day: row.get::<_, i64>(2)? as u64,
            version: row.get::<_, i64>(3)? as u64,
            price: row.get::<_, i64>(4)? as u64,
            stock: row.get::<_, i64>(5)? as u32,
            available: row.get::<_, i64>(6)?.clamp(0, u32::MAX as i64) as u32,
            currency: row.get(7)?,
            title: row.get(8)?,
            description: row.get(9)?,
            active: row.get::<_, i64>(10)? != 0,
            sig_hex: hex::encode(sig),
        })
    }

    pub fn get_listing(&self, id: &[u8; 16]) -> Result<Option<Listing>, String> {
        self.conn
            .query_row(
                "SELECT l.id,l.seller,l.day,l.version,l.price,l.stock,
                        l.stock - COALESCE((SELECT SUM(o.qty) FROM orders o
                                            WHERE o.listing_id=l.id AND o.status IN (0,1,2)),0),
                        l.currency,l.title,l.description,l.active,l.sig
                 FROM listings l WHERE l.id=?",
                params![id.as_slice()],
                Self::listing_from_row,
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    /// Active listings, newest coarse day first. `query` is a simple
    /// title/description contains filter; `seller` narrows to one key.
    pub fn list_listings(
        &self,
        offset: usize,
        limit: usize,
        query: &str,
        seller: Option<&[u8; 32]>,
    ) -> Result<Vec<Listing>, String> {
        let limit = limit.clamp(1, MAX_LISTINGS_PAGE) as i64;
        let pattern = format!(
            "%{}%",
            query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let seller_bytes: Option<&[u8]> = seller.map(|s| s.as_slice());
        let mut stmt = self
            .conn
            .prepare(
                "SELECT l.id,l.seller,l.day,l.version,l.price,l.stock,
                        l.stock - COALESCE((SELECT SUM(o.qty) FROM orders o
                                            WHERE o.listing_id=l.id AND o.status IN (0,1,2)),0),
                        l.currency,l.title,l.description,l.active,l.sig
                 FROM listings l
                 WHERE l.active=1
                   AND (?1='' OR l.title LIKE ?2 ESCAPE '\\' OR l.description LIKE ?2 ESCAPE '\\')
                   AND (?3 IS NULL OR l.seller=?3)
                 ORDER BY l.day DESC, l.id ASC LIMIT ?4 OFFSET ?5",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                params![query, pattern, seller_bytes, limit, offset as i64],
                Self::listing_from_row,
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    // ---- orders ----

    /// Reserve stock and record a buyer-signed order atomically.
    ///
    /// The signed listing row is never rewritten by an order, so its `stock`
    /// (and therefore its signature) stays valid. Availability is derived as
    /// `stock - SUM(qty of reserved/accepted/fulfilled orders)`, computed
    /// inside this transaction, so two concurrent orders cannot both reserve
    /// the last unit.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_order(
        &self,
        id: &[u8; 16],
        listing: &[u8; 16],
        buyer: &[u8; 32],
        day: u64,
        qty: u32,
        price: u64,
        version: u64,
        note: &str,
        sig: &[u8],
    ) -> Result<(), String> {
        if note.as_bytes().len() > MAX_NOTE_BYTES {
            return Err("note too long".into());
        }
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let (seller, stock, active, listed_price, listed_version): (Vec<u8>, i64, i64, i64, i64) =
            tx.query_row(
                "SELECT seller,stock,active,price,version FROM listings WHERE id=?",
                params![listing.as_slice()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no such listing".to_string())?;
        if active == 0 {
            return Err("listing is not active".into());
        }
        if buyer.as_slice() == seller.as_slice() {
            return Err("cannot order your own listing".into());
        }
        if price != listed_price as u64 || version != listed_version as u64 {
            return Err("listing price or version changed".into());
        }
        if qty == 0 {
            return Err("quantity must be positive".into());
        }
        let held: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(qty),0) FROM orders
                 WHERE listing_id=? AND status IN (0,1,2)",
                params![listing.as_slice()],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if (qty as i64) > stock - held {
            return Err("not enough stock".into());
        }
        tx.execute(
            "INSERT INTO orders(id,listing_id,buyer,seller,qty,note,status,day,created,sig,price,version)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                id.as_slice(),
                listing.as_slice(),
                buyer.as_slice(),
                seller.as_slice(),
                qty as i64,
                note,
                OrderStatus::Reserved.code() as i64,
                day as i64,
                Self::now_unix() as i64,
                sig,
                price as i64,
                version as i64
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn order_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Order> {
        let id: Vec<u8> = row.get(0)?;
        let listing: Vec<u8> = row.get(1)?;
        let buyer: Vec<u8> = row.get(2)?;
        let seller: Vec<u8> = row.get(3)?;
        let sig: Vec<u8> = row.get(8)?;
        Ok(Order {
            id_hex: hex::encode(id),
            listing_hex: hex::encode(listing),
            buyer_hex: hex::encode(buyer),
            seller_hex: hex::encode(seller),
            qty: row.get::<_, i64>(4)? as u32,
            price: row.get::<_, i64>(9)? as u64,
            version: row.get::<_, i64>(10)? as u64,
            note: row.get(5)?,
            status: row.get::<_, i64>(6)? as u8,
            day: row.get::<_, i64>(7)? as u64,
            sig_hex: hex::encode(sig),
        })
    }

    /// Buyer/seller keys of an order, for participant checks.
    pub fn order_parties(&self, id: &[u8; 16]) -> Result<Option<([u8; 32], [u8; 32])>, String> {
        self.conn
            .query_row(
                "SELECT buyer,seller FROM orders WHERE id=?",
                params![id.as_slice()],
                |row| {
                    let buyer: Vec<u8> = row.get(0)?;
                    let seller: Vec<u8> = row.get(1)?;
                    Ok((buyer, seller))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?
            .map(|(b, s)| {
                if b.len() != 32 || s.len() != 32 {
                    return Err("corrupt order keys".to_string());
                }
                let mut buyer = [0u8; 32];
                let mut seller = [0u8; 32];
                buyer.copy_from_slice(&b);
                seller.copy_from_slice(&s);
                Ok((buyer, seller))
            })
            .transpose()
    }

    /// Apply a role-scoped state transition. Illegal transitions are refused.
    /// The signed proof is stored with the transition so clients can replay
    /// the chain; availability is derived from order status, so declining or
    /// cancelling releases the reservation without touching the listing row.
    pub fn update_order_status(
        &self,
        id: &[u8; 16],
        actor: &[u8; 32],
        next: OrderStatus,
        day: u64,
        note: &str,
        sig: &[u8],
    ) -> Result<(), String> {
        if next == OrderStatus::Reserved {
            return Err("reserved is not a settable status".into());
        }
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let (buyer, seller, status): (Vec<u8>, Vec<u8>, i64) = tx
            .query_row(
                "SELECT buyer,seller,status FROM orders WHERE id=?",
                params![id.as_slice()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no such order".to_string())?;
        let role = if actor.as_slice() == buyer.as_slice() {
            ActorRole::Buyer
        } else if actor.as_slice() == seller.as_slice() {
            ActorRole::Seller
        } else {
            return Err("not a party to this order".into());
        };
        let current = OrderStatus::from_code(status as u8)
            .ok_or_else(|| "corrupt order status".to_string())?;
        if !current.can_transition(role, next) {
            return Err(format!(
                "illegal transition {} -> {} for {:?}",
                current.as_str(),
                next.as_str(),
                role
            ));
        }
        tx.execute(
            "INSERT INTO order_status_events(order_id,from_code,status,actor,day,note,sig,created)
             VALUES(?,?,?,?,?,?,?,?)",
            params![
                id.as_slice(),
                current.code() as i64,
                next.code() as i64,
                actor.as_slice(),
                day as i64,
                note,
                sig,
                Self::now_unix() as i64
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE orders SET status=? WHERE id=?",
            params![next.code() as i64, id.as_slice()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Signed transition chain in application order, for client verification.
    pub fn status_events_for(&self, order: &[u8; 16]) -> Result<Vec<StatusEvent>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT from_code,status,actor,day,note,sig FROM order_status_events
                 WHERE order_id=? ORDER BY seq ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![order.as_slice()], |row| {
                let actor: Vec<u8> = row.get(2)?;
                let sig: Vec<u8> = row.get(5)?;
                Ok(StatusEvent {
                    from_code: row.get::<_, i64>(0)? as u8,
                    status_code: row.get::<_, i64>(1)? as u8,
                    actor_hex: hex::encode(actor),
                    day: row.get::<_, i64>(3)? as u64,
                    note: row.get(4)?,
                    sig_hex: hex::encode(sig),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    /// `/orders` assembly in a fixed number of queries: one for the orders,
    /// one for the latest message page of every thread, one for their reviews,
    /// one for every signed transition. `message_limit` is clamped to the wire
    /// page cap so a caller cannot turn this into an unbounded table dump.
    pub fn orders_with_details_for(
        &self,
        key: &[u8; 32],
        message_limit: usize,
    ) -> Result<Vec<OrderDetail>, String> {
        let orders = self.orders_for(key)?;
        if orders.is_empty() {
            return Ok(Vec::new());
        }
        let page = message_limit.clamp(1, MAX_MESSAGES_PAGE);

        // ROW_NUMBER over each thread keeps only the newest `page` rows. The
        // window total lets us report a cursor without a COUNT query per order.
        let mut stmt = self
            .conn
            .prepare(
                "SELECT order_id,author,day,body,sig,total FROM (
                   SELECT order_id,seq,author,day,body,sig,
                          COUNT(*) OVER (PARTITION BY order_id) AS total,
                          ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY seq DESC) AS rn
                   FROM order_messages
                 ) WHERE rn <= ? ORDER BY order_id,seq ASC",
            )
            .map_err(|e| e.to_string())?;
        let mut pages: HashMap<Vec<u8>, (usize, Vec<OrderMessage>)> = HashMap::new();
        let mut rows = stmt
            .query_map(params![page as i64], |row| {
                let order_id: Vec<u8> = row.get(0)?;
                let author: Vec<u8> = row.get(1)?;
                let sig: Vec<u8> = row.get(4)?;
                Ok((
                    order_id,
                    row.get::<_, i64>(5)? as usize,
                    OrderMessage {
                        author_hex: hex::encode(author),
                        day: row.get::<_, i64>(2)? as u64,
                        body: row.get(3)?,
                        sig_hex: hex::encode(sig),
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in &mut rows {
            let (id, total, message) = row.map_err(|e| e.to_string())?;
            pages
                .entry(id)
                .or_insert((total, Vec::new()))
                .1
                .push(message);
        }

        let mut stmt = self
            .conn
            .prepare(
                "SELECT order_id,seller,author,rating,body,day,sig FROM reviews
                 WHERE order_id IN (SELECT id FROM orders WHERE buyer=? OR seller=?)",
            )
            .map_err(|e| e.to_string())?;
        let mut reviews: HashMap<Vec<u8>, Review> = HashMap::new();
        let mut rows = stmt
            .query_map(params![key.as_slice(), key.as_slice()], |row| {
                let id: Vec<u8> = row.get(0)?;
                Ok((id, Self::review_from_row(row)?))
            })
            .map_err(|e| e.to_string())?;
        for row in &mut rows {
            let (id, review) = row.map_err(|e| e.to_string())?;
            reviews.insert(id, review);
        }

        let mut stmt = self
            .conn
            .prepare(
                "SELECT order_id,from_code,status,actor,day,note,sig FROM order_status_events
                 WHERE order_id IN (SELECT id FROM orders WHERE buyer=? OR seller=?)
                 ORDER BY order_id,seq ASC",
            )
            .map_err(|e| e.to_string())?;
        let mut events: HashMap<Vec<u8>, Vec<StatusEvent>> = HashMap::new();
        let mut rows = stmt
            .query_map(params![key.as_slice(), key.as_slice()], |row| {
                let id: Vec<u8> = row.get(0)?;
                let actor: Vec<u8> = row.get(3)?;
                let sig: Vec<u8> = row.get(6)?;
                Ok((
                    id,
                    StatusEvent {
                        from_code: row.get::<_, i64>(1)? as u8,
                        status_code: row.get::<_, i64>(2)? as u8,
                        actor_hex: hex::encode(actor),
                        day: row.get::<_, i64>(4)? as u64,
                        note: row.get(5)?,
                        sig_hex: hex::encode(sig),
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in &mut rows {
            let (id, event) = row.map_err(|e| e.to_string())?;
            events.entry(id).or_default().push(event);
        }

        let mut details = Vec::with_capacity(orders.len());
        for order in orders {
            let id = hex::decode(&order.id_hex).map_err(|_| "corrupt order id".to_string())?;
            let (total, messages) = pages.remove(&id).unwrap_or((0, Vec::new()));
            let next_offset = if messages.len() < total {
                Some(messages.len())
            } else {
                None
            };
            details.push(OrderDetail {
                order,
                messages: MessagePage {
                    messages,
                    total,
                    next_offset,
                },
                review: reviews.remove(&id),
                events: events.remove(&id).unwrap_or_default(),
            });
        }
        Ok(details)
    }

    /// Every order where `key` is the buyer or the seller, newest first.
    pub fn orders_for(&self, key: &[u8; 32]) -> Result<Vec<Order>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id,listing_id,buyer,seller,qty,note,status,day,sig,price,version
                 FROM orders WHERE buyer=? OR seller=? ORDER BY created DESC, id ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                params![key.as_slice(), key.as_slice()],
                Self::order_from_row,
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    // ---- order messages ----

    pub fn insert_order_message(
        &self,
        order: &[u8; 16],
        author: &[u8; 32],
        day: u64,
        body: &str,
        sig: &[u8],
    ) -> Result<(), String> {
        if body.as_bytes().len() > MAX_MESSAGE_BYTES {
            return Err("message too long".into());
        }
        // Count-and-insert in one transaction: two parties replying at once
        // cannot both slip past the thread cap.
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM order_messages WHERE order_id=?",
                params![order.as_slice()],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count as usize >= MAX_ORDER_MESSAGES {
            return Err("message thread is full".into());
        }
        tx.execute(
            "INSERT INTO order_messages(order_id,author,day,body,sig,created)
             VALUES(?,?,?,?,?,?)",
            params![
                order.as_slice(),
                author.as_slice(),
                day as i64,
                body,
                sig,
                Self::now_unix() as i64
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Read `limit` newest messages, skipping `offset` newest ones, ordered
    /// oldest-to-newest. The total count provides a next-page cursor without
    /// loading the whole thread over the mixnet.
    pub fn messages_for(
        &self,
        order: &[u8; 16],
        offset: usize,
        limit: usize,
    ) -> Result<MessagePage, String> {
        let total: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM order_messages WHERE order_id=?",
                params![order.as_slice()],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let limit = limit.clamp(1, MAX_MESSAGES_PAGE) as i64;
        let offset = offset.min(total.max(0) as usize) as i64;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT author,day,body,sig FROM (
                   SELECT seq,author,day,body,sig FROM order_messages WHERE order_id=?
                   ORDER BY seq DESC LIMIT ? OFFSET ?
                 ) ORDER BY seq ASC",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map(params![order.as_slice(), limit, offset], |row| {
                let author: Vec<u8> = row.get(0)?;
                let sig: Vec<u8> = row.get(3)?;
                Ok(OrderMessage {
                    author_hex: hex::encode(author),
                    day: row.get::<_, i64>(1)? as u64,
                    body: row.get(2)?,
                    sig_hex: hex::encode(sig),
                })
            })
            .map_err(|e| e.to_string())?;
        let mut messages = Vec::with_capacity(limit as usize);
        for row in &mut rows {
            messages.push(row.map_err(|e| e.to_string())?);
        }
        // `offset` counts back from the newest row, so a cursor is only useful
        // when older rows remain before this page.
        let next_offset = if offset as usize + messages.len() < total.max(0) as usize {
            Some(offset as usize + messages.len())
        } else {
            None
        };
        Ok(MessagePage {
            messages,
            total: total.max(0) as usize,
            next_offset,
        })
    }

    // ---- reviews ----

    /// Record a buyer's review of a fulfilled order. Enforced here so no
    /// route can bypass it: author must be the buyer, the order must be
    /// fulfilled, and each order accepts exactly one review.
    pub fn insert_review(
        &self,
        order: &[u8; 16],
        author: &[u8; 32],
        seller: &[u8; 32],
        rating: u8,
        body: &str,
        day: u64,
        sig: &[u8],
    ) -> Result<(), String> {
        if !shop_format::review::rating_is_valid(rating) {
            return Err("rating must be 1..=5".into());
        }
        if body.as_bytes().len() > MAX_REVIEW_BYTES {
            return Err("review too long".into());
        }
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let (buyer, order_seller, listing, status): (Vec<u8>, Vec<u8>, Vec<u8>, i64) = tx
            .query_row(
                "SELECT buyer,seller,listing_id,status FROM orders WHERE id=?",
                params![order.as_slice()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no such order".to_string())?;
        if author.as_slice() != buyer.as_slice() {
            return Err("only the buyer may review an order".into());
        }
        if author.as_slice() == order_seller.as_slice() {
            return Err("seller cannot review their own sale".into());
        }
        if seller.as_slice() != order_seller.as_slice() {
            return Err("review seller does not match the order".into());
        }
        let status = OrderStatus::from_code(status as u8)
            .ok_or_else(|| "corrupt order status".to_string())?;
        if !status.is_reviewable() {
            return Err("order is not fulfilled yet".into());
        }
        let exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM reviews WHERE order_id=?",
                params![order.as_slice()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_some() {
            return Err("order already reviewed".into());
        }
        tx.execute(
            "INSERT INTO reviews(order_id,listing_id,seller,author,rating,body,day,sig,created)
             VALUES(?,?,?,?,?,?,?,?,?)",
            params![
                order.as_slice(),
                listing,
                seller,
                author.as_slice(),
                rating as i64,
                body,
                day as i64,
                sig,
                Self::now_unix() as i64
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn review_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Review> {
        let order: Vec<u8> = row.get(0)?;
        let seller: Vec<u8> = row.get(1)?;
        let author: Vec<u8> = row.get(2)?;
        let sig: Vec<u8> = row.get(6)?;
        Ok(Review {
            order_hex: hex::encode(order),
            seller_hex: hex::encode(seller),
            author_hex: hex::encode(author),
            rating: row.get::<_, i64>(3)? as u8,
            body: row.get(4)?,
            day: row.get::<_, i64>(5)? as u64,
            sig_hex: hex::encode(sig),
        })
    }

    pub fn reviews_for_seller(
        &self,
        seller: &[u8; 32],
        offset: usize,
        limit: usize,
    ) -> Result<Vec<Review>, String> {
        let limit = limit.clamp(1, MAX_LISTINGS_PAGE) as i64;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT order_id,seller,author,rating,body,day,sig FROM reviews
                 WHERE seller=? ORDER BY created DESC, order_id ASC LIMIT ? OFFSET ?",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                params![seller.as_slice(), limit, offset as i64],
                Self::review_from_row,
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    /// `(count, sum)` for one seller, straight from the stored ratings.
    pub fn review_summary(&self, seller: &[u8; 32]) -> Result<(u64, u64), String> {
        self.conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(rating),0) FROM reviews WHERE seller=?",
                params![seller.as_slice()],
                |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
            )
            .map_err(|e| e.to_string())
    }

    pub fn counts(&self) -> Result<(u64, u64), String> {
        let listings: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM listings WHERE active=1", [], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        let orders: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        Ok((listings as u64, orders as u64))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_listing(s: &Store, id: [u8; 16], seller: [u8; 32], version: u64, stock: u32) {
        s.upsert_listing(
            &id, &seller, 20_400, version, 1_00, stock, b"USD", "Lamp", "Warm", &[9u8; 64],
        )
        .unwrap();
    }

    #[test]
    fn listing_versions_are_monotonic_and_owner_bound() {
        let s = Store::open_in_memory().unwrap();
        write_listing(&s, [1u8; 16], [2u8; 32], 1, 5);
        // Replay of the same version is refused (no price/stock rollback).
        assert!(s
            .upsert_listing(
                &[1u8; 16], &[2u8; 32], 20_400, 1, 0, 99, b"USD", "Lamp", "Warm", &[9u8; 64]
            )
            .is_err());
        // Another seller cannot take the id.
        assert!(s
            .upsert_listing(
                &[1u8; 16], &[3u8; 32], 20_400, 2, 0, 99, b"USD", "Lamp", "Warm", &[9u8; 64]
            )
            .is_err());
        // A higher version from the owner wins.
        write_listing(&s, [1u8; 16], [2u8; 32], 2, 7);
        let listing = s.get_listing(&[1u8; 16]).unwrap().unwrap();
        assert_eq!((listing.version, listing.stock), (2, 7));
    }

    #[test]
    fn browse_filters_by_text_and_seller_and_hides_deleted() {
        let s = Store::open_in_memory().unwrap();
        write_listing(&s, [1u8; 16], [2u8; 32], 1, 5);
        let mut other = [0u8; 16];
        other[0] = 2;
        s.upsert_listing(
            &other, &[3u8; 32], 20_401, 1, 9_99, 1, b"EUR", "Chair", "Oak", &[8u8; 64],
        )
        .unwrap();

        assert_eq!(s.list_listings(0, 10, "", None).unwrap().len(), 2);
        assert_eq!(s.list_listings(0, 10, "chair", None).unwrap().len(), 1);
        assert_eq!(
            s.list_listings(0, 10, "", Some(&[2u8; 32])).unwrap().len(),
            1
        );
        // `%` is treated literally, not as a wildcard.
        assert_eq!(s.list_listings(0, 10, "%", None).unwrap().len(), 0);

        assert!(s.delete_listing(&[2u8; 32], &[1u8; 16]).unwrap());
        assert!(!s.delete_listing(&[2u8; 32], &[1u8; 16]).unwrap());
        assert_eq!(s.list_listings(0, 10, "", None).unwrap().len(), 1);
        // The soft-deleted row still resolves for existing orders.
        assert!(!s.get_listing(&[1u8; 16]).unwrap().unwrap().active);
    }

    #[test]
    fn orders_reserve_release_and_consume_stock() {
        let s = Store::open_in_memory().unwrap();
        let listing = [1u8; 16];
        let buyer = [4u8; 32];
        write_listing(&s, listing, [2u8; 32], 1, 5);

        // A seller cannot buy their own listing and manufacture a review.
        assert!(s
            .insert_order(
                &[10u8; 16],
                &listing,
                &[2u8; 32],
                20_400,
                1,
                1_00,
                1,
                "hi",
                &[6u8; 64]
            )
            .is_err());

        // Terms are frozen: a buyer cannot reserve against a stale price or
        // version, even if the signature itself is valid for those fields.
        assert!(s
            .insert_order(
                &[11u8; 16],
                &listing,
                &buyer,
                20_400,
                1,
                99,
                1,
                "hi",
                &[6u8; 64]
            )
            .is_err());
        assert!(s
            .insert_order(
                &[12u8; 16],
                &listing,
                &buyer,
                20_400,
                1,
                1_00,
                2,
                "hi",
                &[6u8; 64]
            )
            .is_err());

        s.insert_order(
            &[7u8; 16], &listing, &buyer, 20_400, 3, 1_00, 1, "hi", &[6u8; 64],
        )
        .unwrap();
        let after_order = s.get_listing(&listing).unwrap().unwrap();
        // The signed stock never changes; only derived availability does.
        assert_eq!((after_order.stock, after_order.available), (5, 2));

        // Oversell refused and availability unchanged.
        assert!(s
            .insert_order(&[8u8; 16], &listing, &buyer, 20_400, 3, 1_00, 1, "hi", &[6u8; 64])
            .is_err());
        let after_oversell = s.get_listing(&listing).unwrap().unwrap();
        assert_eq!((after_oversell.stock, after_oversell.available), (5, 2));

        // Buyer cancel returns the reservation.
        s.update_order_status(
            &[7u8; 16],
            &buyer,
            OrderStatus::Cancelled,
            20_400,
            "ok",
            &[3u8; 64],
        )
        .unwrap();
        let after_cancel = s.get_listing(&listing).unwrap().unwrap();
        assert_eq!((after_cancel.stock, after_cancel.available), (5, 5));

        // Accepted then fulfilled consumes it.
        s.insert_order(
            &[9u8; 16], &listing, &buyer, 20_400, 2, 1_00, 1, "hi", &[6u8; 64],
        )
        .unwrap();
        s.update_order_status(
            &[9u8; 16],
            &[2u8; 32],
            OrderStatus::Accepted,
            20_400,
            "ok",
            &[3u8; 64],
        )
        .unwrap();
        s.update_order_status(
            &[9u8; 16],
            &[2u8; 32],
            OrderStatus::Fulfilled,
            20_400,
            "ok",
            &[3u8; 64],
        )
        .unwrap();
        let fulfilled = s.get_listing(&listing).unwrap().unwrap();
        assert_eq!((fulfilled.stock, fulfilled.available), (5, 3));

        // Terminal state: no further moves.
        assert!(s
            .update_order_status(
                &[9u8; 16],
                &buyer,
                OrderStatus::Cancelled,
                20_400,
                "ok",
                &[3u8; 64]
            )
            .is_err());
        // A non-party is refused outright.
        assert!(s
            .update_order_status(
                &[9u8; 16],
                &[5u8; 32],
                OrderStatus::Cancelled,
                20_400,
                "ok",
                &[3u8; 64]
            )
            .is_err());
    }

    #[test]
    fn signed_status_events_expose_the_transition_chain() {
        let s = Store::open_in_memory().unwrap();
        let order = [9u8; 16];
        let buyer = [4u8; 32];
        let seller = [2u8; 32];
        write_listing(&s, [1u8; 16], seller, 1, 5);
        s.insert_order(
            &order, &[1u8; 16], &buyer, 20_400, 1, 1_00, 1, "hi", &[6u8; 64],
        )
        .unwrap();
        assert!(s.status_events_for(&order).unwrap().is_empty());

        s.update_order_status(
            &order,
            &seller,
            OrderStatus::Accepted,
            20_400,
            "ok",
            &[3u8; 64],
        )
        .unwrap();
        s.update_order_status(
            &order,
            &seller,
            OrderStatus::Fulfilled,
            20_401,
            "shipped",
            &[4u8; 64],
        )
        .unwrap();
        let events = s.status_events_for(&order).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!((events[0].from_code, events[0].status_code), (0, 1));
        assert_eq!((events[1].from_code, events[1].status_code), (1, 2));
        assert_eq!(events[1].actor_hex, hex::encode(seller));
        assert_eq!(events[1].day, 20_401);
        assert_eq!(events[1].note, "shipped");

        // A provider that rewrites the state without a signed event leaves a
        // chain that no longer ends at the reported status: clients reject it.
        s.conn
            .execute(
                "UPDATE orders SET status=? WHERE id=?",
                params![OrderStatus::Reserved.code() as i64, order.as_slice()],
            )
            .unwrap();
        let forged = &s.orders_for(&buyer).unwrap()[0];
        assert_ne!(
            forged.status as u32,
            events.last().unwrap().status_code as u32
        );
    }

    #[test]
    fn orders_are_listed_for_both_parties_only() {
        let s = Store::open_in_memory().unwrap();
        let listing = [1u8; 16];
        let buyer = [4u8; 32];
        let seller = [2u8; 32];
        write_listing(&s, listing, seller, 1, 5);
        s.insert_order(
            &[7u8; 16], &listing, &buyer, 20_400, 1, 1_00, 1, "hi", &[6u8; 64],
        )
        .unwrap();
        assert_eq!(s.orders_for(&buyer).unwrap().len(), 1);
        assert_eq!(s.orders_for(&seller).unwrap().len(), 1);
        assert!(s.orders_for(&[5u8; 32]).unwrap().is_empty());
    }

    #[test]
    fn message_threads_are_bounded_and_paged() {
        let s = Store::open_in_memory().unwrap();
        let order = [7u8; 16];
        let author = [2u8; 32];
        for i in 0..MAX_ORDER_MESSAGES {
            s.insert_order_message(&order, &author, 20_400, &format!("message {i}"), &[6u8; 64])
                .unwrap();
        }
        assert_eq!(
            s.insert_order_message(&order, &author, 20_400, "one too many", &[6u8; 64])
                .unwrap_err(),
            "message thread is full"
        );

        let page = s.messages_for(&order, 0, 10).unwrap();
        assert_eq!(page.total, MAX_ORDER_MESSAGES);
        assert_eq!(page.messages.len(), 10);
        assert_eq!(page.messages[0].body, "message 490");
        assert_eq!(page.messages[9].body, "message 499");
        assert_eq!(page.next_offset, Some(10));

        let older = s.messages_for(&order, 490, 10).unwrap();
        assert_eq!(older.messages.len(), 10);
        assert_eq!(older.messages[0].body, "message 0");
        assert!(older.next_offset.is_none());

        // Callers cannot bypass the page cap with a huge limit, and an offset
        // past the end is an empty page rather than an error.
        assert_eq!(
            s.messages_for(&order, 0, usize::MAX)
                .unwrap()
                .messages
                .len(),
            MAX_MESSAGES_PAGE
        );
        let past = s.messages_for(&order, usize::MAX, 10).unwrap();
        assert!(past.messages.is_empty());
        assert!(past.next_offset.is_none());
    }

    #[test]
    fn orders_with_details_matches_per_order_reads() {
        let s = Store::open_in_memory().unwrap();
        let listing = [1u8; 16];
        let order = [7u8; 16];
        let buyer = [4u8; 32];
        let seller = [2u8; 32];
        write_listing(&s, listing, seller, 1, 5);
        s.insert_order(
            &order, &listing, &buyer, 20_400, 1, 1_00, 1, "hi", &[6u8; 64],
        )
        .unwrap();
        for text in ["hello", "when?", "soon"] {
            s.insert_order_message(&order, &buyer, 20_400, text, &[5u8; 64])
                .unwrap();
        }
        for next in [OrderStatus::Accepted, OrderStatus::Fulfilled] {
            s.update_order_status(&order, &seller, next, 20_400, "", &[5u8; 64])
                .unwrap();
        }
        s.insert_review(&order, &buyer, &seller, 5, "great", 20_400, &[3u8; 64])
            .unwrap();

        let details = s
            .orders_with_details_for(&buyer, DEFAULT_MESSAGES_PAGE)
            .unwrap();
        assert_eq!(details.len(), 1);
        let detail = &details[0];
        assert_eq!(detail.order.id_hex, hex::encode(order));
        assert_eq!(detail.messages.messages.len(), 3);
        assert_eq!(detail.messages.total, 3);
        assert!(detail.messages.next_offset.is_none());
        assert_eq!(detail.review.as_ref().unwrap().body, "great");
        assert_eq!(detail.events.len(), 2);

        // The seller sees the same assembly, and a page cap of two leaves a
        // cursor without changing the reported thread length.
        let seller_view = s.orders_with_details_for(&seller, 2).unwrap();
        assert_eq!(seller_view.len(), 1);
        assert_eq!(seller_view[0].messages.messages.len(), 2);
        assert_eq!(seller_view[0].messages.total, 3);
        assert_eq!(seller_view[0].messages.next_offset, Some(2));
        assert!(s.orders_with_details_for(&[9u8; 32], 2).unwrap().is_empty());
    }

    #[test]
    fn reviews_require_the_buyer_fulfilment_and_uniqueness() {
        let s = Store::open_in_memory().unwrap();
        let listing = [1u8; 16];
        let buyer = [4u8; 32];
        let seller = [2u8; 32];
        write_listing(&s, listing, seller, 1, 5);
        s.insert_order(
            &[7u8; 16], &listing, &buyer, 20_400, 1, 1_00, 1, "hi", &[6u8; 64],
        )
        .unwrap();

        // Not fulfilled yet.
        assert!(s
            .insert_review(&[7u8; 16], &buyer, &seller, 5, "great", 20_400, &[3u8; 64])
            .is_err());
        s.update_order_status(
            &[7u8; 16],
            &seller,
            OrderStatus::Accepted,
            20_400,
            "ok",
            &[3u8; 64],
        )
        .unwrap();
        s.update_order_status(
            &[7u8; 16],
            &seller,
            OrderStatus::Fulfilled,
            20_400,
            "ok",
            &[3u8; 64],
        )
        .unwrap();

        // Seller cannot review their own sale.
        assert!(s
            .insert_review(&[7u8; 16], &seller, &seller, 5, "great", 20_400, &[3u8; 64])
            .is_err());
        // Out-of-range rating.
        assert!(s
            .insert_review(&[7u8; 16], &buyer, &seller, 6, "great", 20_400, &[3u8; 64])
            .is_err());
        // The seller in the signed review must be the order's seller.
        assert!(s
            .insert_review(&[7u8; 16], &buyer, &[5u8; 32], 5, "great", 20_400, &[3u8; 64])
            .is_err());

        s.insert_review(&[7u8; 16], &buyer, &seller, 4, "good", 20_400, &[3u8; 64])
            .unwrap();
        // One review per order.
        assert!(s
            .insert_review(&[7u8; 16], &buyer, &seller, 5, "again", 20_400, &[3u8; 64])
            .is_err());

        assert_eq!(s.review_summary(&seller).unwrap(), (1, 4));
        assert_eq!(s.reviews_for_seller(&seller, 0, 10).unwrap().len(), 1);
        assert_eq!(s.reviews_for_seller(&[5u8; 32], 0, 10).unwrap().len(), 0);
    }
}
