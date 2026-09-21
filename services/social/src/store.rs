//! Metadata-minimal SQLite store.
//!
//! What is stored per row — and, more importantly, what is NOT:
//!
//! * posts: random 16-byte id, author pubkey, coarse day, body, optional
//!   16-byte parent id (`in_reply_to`, NULL for top-level posts), signature,
//!   server sequence (ordering only). No IPs, no Nym addresses, no precise
//!   timestamps, no sender tags. Thread assembly never happens here: the
//!   parent is stored opaquely and served back verbatim; clients build
//!   threads locally.
//! * profiles: author pubkey, display name, bio, day, signature. Self-asserted.
//! * DMs: recipient pubkey, nonce, opaque ciphertext, creation time (for TTL
//!   pruning only). The server cannot read the plaintext (E2E, see docs).
//! * follows/likes/read-receipts: NOT stored. The feed is global chronological;
//!   clients filter locally. No social graph, no counters, no read tracking.
//!
//! SQLite is embedded (no network listener, no separate process), single file
//! (backup = copy one file), WAL mode for concurrent readers. Filesystem
//! permissions (0600) + volume/full-disk encryption cover data at rest; see
//! `docs/09-social.md` for what encryption does and does not buy you.

use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};

/// DM lifetime in seconds (7 days). Expired DMs are pruned on write.
pub const DM_TTL_SECS: u64 = 7 * 86_400;

/// Max stored field sizes (also bounded by the envelope cap upstream).
pub const MAX_POST_BYTES: usize = 1400;
pub const MAX_NAME_CHARS: usize = 40;
pub const MAX_BIO_CHARS: usize = 280;
pub const MAX_DM_BYTES: usize = 1800;

pub struct Post {
    pub seq: i64,
    pub id_hex: String,
    pub author_hex: String,
    pub day: u64,
    pub body: String,
    /// Hex of the parent post id, or `None` for a top-level post.
    pub in_reply_to_hex: Option<String>,
    pub sig_hex: String,
}

pub struct Profile {
    pub author_hex: String,
    pub name: String,
    pub bio: String,
    pub day: u64,
}

pub struct DirectMessage {
    pub id: i64,
    pub epub_hex: String,
    pub nonce_hex: String,
    pub ciphertext_b64: String,
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        let store = Self { conn };
        store.init()?;
        Ok(store)
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
                 CREATE TABLE IF NOT EXISTS posts(
                   seq    INTEGER PRIMARY KEY AUTOINCREMENT,
                   id     BLOB NOT NULL UNIQUE,
                   author BLOB NOT NULL,
                   day    INTEGER NOT NULL,
                   body   TEXT NOT NULL,
                   sig    BLOB NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_posts_seq ON posts(seq);
                 CREATE TABLE IF NOT EXISTS profiles(
                   author BLOB PRIMARY KEY,
                   name   TEXT NOT NULL,
                   bio    TEXT NOT NULL,
                   day    INTEGER NOT NULL,
                   sig    BLOB NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS dms(
                   id      INTEGER PRIMARY KEY AUTOINCREMENT,
                   recip   BLOB NOT NULL,
                   epub    BLOB NOT NULL,
                   nonce   BLOB NOT NULL,
                   ct      BLOB NOT NULL,
                   created INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_dms_recip ON dms(recip);",
            )
            .map_err(|e| e.to_string())?;
        // Threaded-replies migration for databases created before the
        // `in_reply_to` column existed. The ALTER is guarded by matching
        // the "duplicate column name" error; any other error propagates.
        match self
            .conn
            .execute("ALTER TABLE posts ADD COLUMN in_reply_to BLOB", [])
        {
            Ok(_) => {}
            Err(e) => {
                if !e.to_string().contains("duplicate column name") {
                    return Err(e.to_string());
                }
            }
        }
        self.conn
            .execute_batch("CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(in_reply_to);")
            .map_err(|e| e.to_string())
    }

    pub fn now_unix() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    // ---- profiles ----

    pub fn upsert_profile(
        &self,
        author: &[u8; 32],
        name: &str,
        bio: &str,
        day: u64,
        sig: &[u8],
    ) -> Result<(), String> {
        if name.chars().count() > MAX_NAME_CHARS {
            return Err("name too long".into());
        }
        if bio.chars().count() > MAX_BIO_CHARS {
            return Err("bio too long".into());
        }
        self.conn
            .execute(
                "INSERT INTO profiles(author,name,bio,day,sig) VALUES(?,?,?,?,?)
                 ON CONFLICT(author) DO UPDATE SET name=excluded.name, bio=excluded.bio,
                 day=excluded.day, sig=excluded.sig",
                params![author.as_slice(), name, bio, day as i64, sig],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_profile(&self, author: &[u8; 32]) -> Result<Option<Profile>, String> {
        self.conn
            .query_row(
                "SELECT author,name,bio,day FROM profiles WHERE author=?",
                params![author.as_slice()],
                |row| {
                    let a: Vec<u8> = row.get(0)?;
                    Ok(Profile {
                        author_hex: hex::encode(a),
                        name: row.get(1)?,
                        bio: row.get(2)?,
                        day: row.get::<_, i64>(3)? as u64,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    // ---- posts ----

    pub fn insert_post(
        &self,
        author: &[u8; 32],
        day: u64,
        body: &str,
        in_reply_to: Option<&[u8; 16]>,
        sig: &[u8],
        rng_id: [u8; 16],
    ) -> Result<i64, String> {
        if body.as_bytes().len() > MAX_POST_BYTES {
            return Err("post too long".into());
        }
        let parent: Option<&[u8]> = in_reply_to.map(|p| p.as_slice());
        self.conn
            .execute(
                "INSERT INTO posts(id,author,day,body,in_reply_to,sig) VALUES(?,?,?,?,?,?)",
                params![rng_id.as_slice(), author.as_slice(), day as i64, body, parent, sig],
            )
            .map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Global chronological feed. `since_seq` is exclusive; `limit` capped.
    /// Posts carry their parent id verbatim — thread assembly is the
    /// client's job.
    pub fn feed(&self, since_seq: i64, limit: usize) -> Result<(Vec<Post>, i64), String> {
        let limit = limit.clamp(1, 50) as i64;
        let mut stmt = self
            .conn
            .prepare("SELECT seq,id,author,day,body,in_reply_to,sig FROM posts WHERE seq>? ORDER BY seq ASC LIMIT ?")
            .map_err(|e| e.to_string())?;
        let posts = stmt
            .query_map(params![since_seq, limit], |row| {
                let id: Vec<u8> = row.get(1)?;
                let author: Vec<u8> = row.get(2)?;
                let parent: Option<Vec<u8>> = row.get(5)?;
                let sig: Vec<u8> = row.get(6)?;
                Ok(Post {
                    seq: row.get(0)?,
                    id_hex: hex::encode(id),
                    author_hex: hex::encode(author),
                    day: row.get::<_, i64>(3)? as u64,
                    body: row.get(4)?,
                    in_reply_to_hex: parent.map(hex::encode),
                    sig_hex: hex::encode(sig),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let next = posts.last().map(|p| p.seq).unwrap_or(since_seq);
        Ok((posts, next))
    }

    /// Fetch one post by its id, for clients filling in missing thread
    /// ancestors. Same shape as a feed item.
    pub fn get_post_by_id(&self, id: &[u8]) -> Result<Option<Post>, String> {
        self.conn
            .query_row(
                "SELECT seq,id,author,day,body,in_reply_to,sig FROM posts WHERE id=?",
                params![id],
                |row| {
                    let pid: Vec<u8> = row.get(1)?;
                    let author: Vec<u8> = row.get(2)?;
                    let parent: Option<Vec<u8>> = row.get(5)?;
                    let sig: Vec<u8> = row.get(6)?;
                    Ok(Post {
                        seq: row.get(0)?,
                        id_hex: hex::encode(pid),
                        author_hex: hex::encode(author),
                        day: row.get::<_, i64>(3)? as u64,
                        body: row.get(4)?,
                        in_reply_to_hex: parent.map(hex::encode),
                        sig_hex: hex::encode(sig),
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn latest_seq(&self) -> Result<i64, String> {
        self.conn
            .query_row("SELECT COALESCE(MAX(seq),0) FROM posts", [], |r| r.get(0))
            .map_err(|e| e.to_string())
    }

    // ---- DMs (opaque dead-drop, destructive read) ----

    pub fn store_dm(
        &self,
        recip: &[u8; 32],
        epub: &[u8; 32],
        nonce: &[u8; 24],
        ct: &[u8],
    ) -> Result<i64, String> {
        if ct.len() > MAX_DM_BYTES {
            return Err("dm too large".into());
        }
        self.prune_dms()?;
        self.conn
            .execute(
                "INSERT INTO dms(recip,epub,nonce,ct,created) VALUES(?,?,?,?,?)",
                params![
                    recip.as_slice(),
                    epub.as_slice(),
                    nonce.as_slice(),
                    ct,
                    Self::now_unix() as i64
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Fetch all DMs for `recip` and DELETE them (destructive read: no read
    /// receipts, no retention beyond delivery).
    pub fn fetch_dms(&self, recip: &[u8; 32]) -> Result<Vec<DirectMessage>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT id,epub,nonce,ct FROM dms WHERE recip=? ORDER BY id ASC")
            .map_err(|e| e.to_string())?;
        let dms = stmt
            .query_map(params![recip.as_slice()], |row| {
                let epub: Vec<u8> = row.get(1)?;
                let nonce: Vec<u8> = row.get(2)?;
                let ct: Vec<u8> = row.get(3)?;
                Ok(DirectMessage {
                    id: row.get(0)?,
                    epub_hex: hex::encode(epub),
                    nonce_hex: hex::encode(nonce),
                    ciphertext_b64: base64::engine::general_purpose::STANDARD.encode(ct),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        self.conn
            .execute("DELETE FROM dms WHERE recip=?", params![recip.as_slice()])
            .map_err(|e| e.to_string())?;
        Ok(dms)
    }

    fn prune_dms(&self) -> Result<(), String> {
        let cutoff = Self::now_unix().saturating_sub(DM_TTL_SECS) as i64;
        self.conn
            .execute("DELETE FROM dms WHERE created<?", params![cutoff])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_round_trip() {
        let s = Store::open_in_memory().unwrap();
        let author = [5u8; 32];
        assert!(s.get_profile(&author).unwrap().is_none());
        s.upsert_profile(&author, "ada", "mixnet enjoyer", 20400, &[9u8; 64])
            .unwrap();
        let p = s.get_profile(&author).unwrap().unwrap();
        assert_eq!((p.name, p.bio, p.day), ("ada".into(), "mixnet enjoyer".into(), 20400));
        s.upsert_profile(&author, "ada2", "", 20401, &[9u8; 64]).unwrap();
        assert_eq!(s.get_profile(&author).unwrap().unwrap().name, "ada2");
        assert!(s.upsert_profile(&author, &"x".repeat(41), "", 0, &[0u8; 64]).is_err());
    }

    #[test]
    fn replies_store_parent_and_resolve_by_id() {
        let s = Store::open_in_memory().unwrap();
        s.insert_post(&[1u8; 32], 20400, "root", None, &[2u8; 64], [7u8; 16])
            .unwrap();
        let root_id = hex::decode(s.get_post_by_id(&[7u8; 16]).unwrap().unwrap().id_hex).unwrap();
        assert_eq!(root_id, [7u8; 16]);
        let mut parent16 = [0u8; 16];
        parent16.copy_from_slice(&root_id);
        // Reply stores its parent; top-level rows read back None.
        s.insert_post(&[2u8; 32], 20400, "reply", Some(&parent16), &[3u8; 64], [8u8; 16])
            .unwrap();
        let (posts, _) = s.feed(0, 10).unwrap();
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[0].in_reply_to_hex, None);
        assert_eq!(posts[1].in_reply_to_hex, Some(hex::encode([7u8; 16])));
        // Lookup by id returns the same shape as the feed.
        let one = s.get_post_by_id(&[8u8; 16]).unwrap().unwrap();
        assert_eq!(one.body, "reply");
        assert_eq!(one.in_reply_to_hex, Some(hex::encode([7u8; 16])));
        assert!(s.get_post_by_id(&[9u8; 16]).unwrap().is_none());
    }

    #[test]
    fn feed_paginates_by_cursor() {
        let s = Store::open_in_memory().unwrap();
        for i in 0..5 {
            s.insert_post(&[1u8; 32], 20400, &format!("post {i}"), None, &[2u8; 64], [i as u8; 16])
                .unwrap();
        }
        let (page1, next) = s.feed(0, 2).unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(page1[0].body, "post 0");
        let (page2, next2) = s.feed(next, 10).unwrap();
        assert_eq!(page2.len(), 3);
        assert_eq!(page2[2].body, "post 4");
        let (empty, same) = s.feed(next2, 10).unwrap();
        assert!(empty.is_empty() && same == next2);
    }

    #[test]
    fn dms_are_opaque_and_destructive() {
        let s = Store::open_in_memory().unwrap();
        let recip = [8u8; 32];
        s.store_dm(&recip, &[7u8; 32], &[1u8; 24], b"ciphertext-bytes")
            .unwrap();
        let got = s.fetch_dms(&recip).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].epub_hex, hex::encode([7u8; 32]));
        assert_eq!(got[0].nonce_hex, hex::encode([1u8; 24]));
        let raw = base64::engine::general_purpose::STANDARD
            .decode(&got[0].ciphertext_b64)
            .unwrap();
        assert_eq!(raw, b"ciphertext-bytes");
        // Second fetch: gone.
        assert!(s.fetch_dms(&recip).unwrap().is_empty());
        // Other recipients unaffected.
        s.store_dm(&[9u8; 32], &[6u8; 32], &[2u8; 24], b"x").unwrap();
        assert!(s.fetch_dms(&recip).unwrap().is_empty());
        assert_eq!(s.fetch_dms(&[9u8; 32]).unwrap().len(), 1);
    }
}
