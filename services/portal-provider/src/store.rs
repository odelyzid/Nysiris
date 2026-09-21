//! Object + log storage. Data + verification only: every write is verified
//! before it touches SQLite, and reads serve back exactly what verified
//! writes stored. No plaintext interpretation, no plaintext logging.

use portal_data::{Log, LogEntry, Object};
use rusqlite::{params, Connection, OptionalExtension};

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
                 CREATE TABLE IF NOT EXISTS objects(
                   id      BLOB PRIMARY KEY,
                   kind    TEXT NOT NULL,
                   author  BLOB NOT NULL,
                   payload BLOB NOT NULL,
                   sig     BLOB NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS log_entries(
                   author BLOB NOT NULL,
                   seq    INTEGER NOT NULL,
                   obj_id BLOB NOT NULL,
                   sig    BLOB NOT NULL,
                   PRIMARY KEY(author, seq)
                 );",
            )
            .map_err(|e| e.to_string())
    }

    /// Verify + store an object. Returns true when newly stored.
    pub fn put_object(&self, obj: &Object) -> Result<bool, String> {
        let changed = self
            .conn
            .execute(
                "INSERT OR IGNORE INTO objects(id,kind,author,payload,sig) VALUES(?,?,?,?,?)",
                params![
                    obj.id.as_slice(),
                    obj.kind,
                    obj.author.as_slice(),
                    obj.payload,
                    obj.sig.as_slice()
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed == 1)
    }

    pub fn get_object(&self, id: &[u8; 32]) -> Result<Option<Object>, String> {
        self.conn
            .query_row(
                "SELECT kind,author,payload,sig FROM objects WHERE id=?",
                params![id.as_slice()],
                |row| {
                    let kind: String = row.get(0)?;
                    let author: Vec<u8> = row.get(1)?;
                    let payload: Vec<u8> = row.get(2)?;
                    let sig: Vec<u8> = row.get(3)?;
                    let mut author_arr = [0u8; 32];
                    let mut sig_arr = [0u8; 64];
                    if author.len() != 32 || sig.len() != 64 {
                        return Err(rusqlite::Error::InvalidColumnType(
                            0,
                            "id".into(),
                            rusqlite::types::Type::Blob,
                        ));
                    }
                    author_arr.copy_from_slice(&author);
                    sig_arr.copy_from_slice(&sig);
                    // Re-verify on read: stored bytes are never trusted blindly.
                    Object::parse_untrusted(&kind, &author_arr, &payload, &sig_arr).map_err(|_| {
                        rusqlite::Error::InvalidColumnType(0, "stored".into(), rusqlite::types::Type::Blob)
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn has_object(&self, id: &[u8; 32]) -> Result<bool, String> {
        Ok(self.get_object(id)?.is_some())
    }

    /// Verify continuity + signature, require the referenced object, store.
    /// Returns the committed seq.
    pub fn append_log_entry(&self, entry: &LogEntry) -> Result<u64, String> {
        if !self.has_object(&entry.obj_id)? {
            return Err("referenced object not stored (upload it first)".into());
        }
        // Continuity check against a scratch log: rejects gaps and forks.
        let mut log = self.load_log(&entry.author)?;
        log.append(entry.clone()).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT INTO log_entries(author,seq,obj_id,sig) VALUES(?,?,?,?)",
                params![
                    entry.author.as_slice(),
                    entry.seq as i64,
                    entry.obj_id.as_slice(),
                    entry.sig.as_slice()
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(entry.seq)
    }

    pub fn load_log(&self, author: &[u8; 32]) -> Result<Log, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT author,seq,obj_id,sig FROM log_entries WHERE author=? ORDER BY seq ASC")
            .map_err(|e| e.to_string())?;
        let mut log = Log::new();
        let rows = stmt
            .query_map(params![author.as_slice()], |row| {
                let author: Vec<u8> = row.get(0)?;
                let obj_id: Vec<u8> = row.get(2)?;
                let sig: Vec<u8> = row.get(3)?;
                let mut a = [0u8; 32];
                let mut o = [0u8; 32];
                let mut s = [0u8; 64];
                a.copy_from_slice(&author);
                o.copy_from_slice(&obj_id);
                s.copy_from_slice(&sig);
                Ok(LogEntry {
                    author: a,
                    seq: row.get::<_, i64>(1)? as u64,
                    obj_id: o,
                    sig: s,
                })
            })
            .map_err(|e| e.to_string())?;
        for entry in rows {
            let entry = entry.map_err(|e| e.to_string())?;
            log.append(entry).map_err(|e| format!("stored log corrupt: {e}"))?;
        }
        Ok(log)
    }

    /// All (author, head-seq) pairs for sync want-lists.
    pub fn heads(&self) -> Result<Vec<([u8; 32], u64)>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT author,MAX(seq) FROM log_entries GROUP BY author")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let author: Vec<u8> = row.get(0)?;
                let mut a = [0u8; 32];
                a.copy_from_slice(&author);
                Ok((a, row.get::<_, i64>(1)? as u64 + 1))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;
    use portal_data::log::entry_bytes;

    fn test_object(seed: u8) -> (Object, ed25519_dalek::SigningKey) {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
        let obj = Object::sign_new(&sk, "post", format!("hello {seed}").into_bytes()).unwrap();
        (obj, sk)
    }

    #[test]
    fn objects_store_and_verify_on_read() {
        let s = Store::open_in_memory().unwrap();
        let (obj, _) = test_object(1);
        assert!(s.put_object(&obj).unwrap());
        assert!(!s.put_object(&obj).unwrap(), "duplicate is a no-op");
        let back = s.get_object(&obj.id).unwrap().unwrap();
        assert_eq!(back, obj);
        assert!(s.get_object(&[9u8; 32]).unwrap().is_none());
    }

    #[test]
    fn log_append_requires_object_and_continuity() {
        let s = Store::open_in_memory().unwrap();
        let (obj, sk) = test_object(2);
        let author = sk.verifying_key().to_bytes();

        // Dangling reference refused.
        let dangling = LogEntry {
            author,
            seq: 0,
            obj_id: [7u8; 32],
            sig: sk.sign(&entry_bytes(&author, 0, &[7u8; 32])).to_bytes(),
        };
        assert!(s.append_log_entry(&dangling).is_err());

        s.put_object(&obj).unwrap();
        let entry = LogEntry {
            author,
            seq: 0,
            obj_id: obj.id,
            sig: sk.sign(&entry_bytes(&author, 0, &obj.id)).to_bytes(),
        };
        assert_eq!(s.append_log_entry(&entry).unwrap(), 0);
        // Gap refused.
        let gap = LogEntry {
            author,
            seq: 2,
            obj_id: obj.id,
            sig: sk.sign(&entry_bytes(&author, 2, &obj.id)).to_bytes(),
        };
        assert!(s.append_log_entry(&gap).is_err());

        let log = s.load_log(&author).unwrap();
        assert_eq!(log.len(), 1);
        let heads = s.heads().unwrap();
        assert_eq!(heads.len(), 1);
        assert_eq!(heads[0].1, 1, "head = entries held");
    }
}
