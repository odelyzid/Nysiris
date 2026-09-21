//! Local-only petnames: human names for hidden services.
//!
//! There is deliberately **no global directory** for Nym addresses —
//! enumerable clients destroy first-contact unlinkability (`docs/05-security.md`
//! §5.7). Petnames are the safe alternative: a private, per-client mapping
//! from a human label ("shop", "printer") to a [`NymUri`](crate::uri::NymUri),
//! stored on the client's own machine and never published.

use std::collections::HashMap;
use std::path::Path;

use crate::uri::{NymUri, UriError};

/// A private label → address map owned by one client.
#[derive(Debug, Clone, Default)]
pub struct PetnameRegistry {
    entries: HashMap<String, NymUri>,
}

impl PetnameRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Bind `petname` to `uri`. Labels are trimmed and lower-cased;
    /// empty labels and re-binding to a *different* address are refused.
    pub fn insert(&mut self, petname: &str, uri: NymUri) -> Result<(), String> {
        let key = normalize(petname)?;
        if let Some(existing) = self.entries.get(&key) {
            if *existing != uri {
                return Err(format!(
                    "petname {key:?} is already bound to a different address"
                ));
            }
        }
        self.entries.insert(key, uri);
        Ok(())
    }

    /// Resolve a petname, or parse the input as a URI directly.
    pub fn resolve(&self, input: &str) -> Result<NymUri, String> {
        let key = input.trim().to_lowercase();
        if let Some(uri) = self.entries.get(&key) {
            return Ok(*uri);
        }
        NymUri::parse(input).map_err(|e: UriError| e.to_string())
    }

    pub fn remove(&mut self, petname: &str) -> bool {
        self.entries
            .remove(&petname.trim().to_lowercase())
            .is_some()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Persist to disk as JSON `{ petname: "nym://..." }`.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let map: HashMap<&str, String> = self
            .entries
            .iter()
            .map(|(k, v)| (k.as_str(), v.to_uri()))
            .collect();
        let json = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    /// Load from disk. Unknown/invalid entries abort the load (fail closed).
    pub fn load(path: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let map: HashMap<String, String> =
            serde_json::from_str(&raw).map_err(|e| format!("petname file invalid: {e}"))?;
        let mut registry = Self::new();
        for (name, uri) in &map {
            let parsed = NymUri::parse(uri).map_err(|e| format!("bad entry {name:?}: {e}"))?;
            registry.insert(name, parsed)?;
        }
        Ok(registry)
    }
}

fn normalize(petname: &str) -> Result<String, String> {
    let key = petname.trim().to_lowercase();
    if key.is_empty() {
        return Err("petname must not be empty".into());
    }
    if key.len() > 64 {
        return Err("petname too long (max 64 chars)".into());
    }
    if !key
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err("petname may only contain letters, digits, '-' and '_'".into());
    }
    Ok(key)
}
