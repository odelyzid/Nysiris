//! Host-level ergonomics: configuration, the address-file convention, and the
//! transport-generic serve harness.

use std::path::PathBuf;

use nym_hidden_service::{HiddenService, NymUri};
use provider_runtime::runner::{hidden_step, run_loop};
use provider_runtime::transport::MixnetRuntime;

/// Environment variables consulted by [`HostConfig::from_env`], in order of
/// precedence. The `SP_*` names are the historical provider variables; the
/// `NYSIRIS_*` names win when both are set.
pub const ENV_DATA_DIR: &str = "NYSIRIS_DATA_DIR";
pub const ENV_DATA_DIR_LEGACY: &str = "SP_DATA_DIR";
pub const ENV_GATEWAY: &str = "NYSIRIS_GATEWAY";
pub const ENV_GATEWAY_LEGACY: &str = "SP_GATEWAY";
pub const ENV_LABEL: &str = "NYSIRIS_SERVICE";

/// Where a hidden service keeps its identity and, by convention, its published
/// Nym address.
///
/// The data directory is the only thing that must survive a restart: it holds
/// the mixnet client keys, so losing it changes the service address and breaks
/// every client that cached it (`docs/04-hosting-services.md` §3.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostConfig {
    /// Mixnet client storage (keys + gateway selection).
    pub data_dir: PathBuf,
    /// Optional gateway identity key to pin for a stable address.
    pub gateway: Option<String>,
    /// Human label used in logs; never published.
    pub label: String,
    /// Where to write the address file (default `<data_dir>/nym-address.txt`).
    pub address_file: Option<PathBuf>,
    /// Whether the host should persist its address after connecting.
    pub write_address_file: bool,
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("./sp-storage"),
            gateway: None,
            label: "nysiris-service".to_string(),
            address_file: None,
            write_address_file: true,
        }
    }
}

impl HostConfig {
    /// Config with the given storage dir and otherwise defaults.
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            ..Self::default()
        }
    }

    /// Resolve from the process environment (see the `ENV_*` constants).
    pub fn from_env() -> Self {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Resolve from an arbitrary lookup, so precedence is unit-testable without
    /// mutating the process environment.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let pick = |now: &str, old: &str| lookup(now).or_else(|| lookup(old));
        let data_dir = pick(ENV_DATA_DIR, ENV_DATA_DIR_LEGACY)
            .filter(|d| !d.trim().is_empty())
            .map_or_else(|| PathBuf::from("./sp-storage"), PathBuf::from);
        let gateway = pick(ENV_GATEWAY, ENV_GATEWAY_LEGACY).filter(|g| !g.trim().is_empty());
        let label = lookup(ENV_LABEL)
            .filter(|l| !l.trim().is_empty())
            .unwrap_or_else(|| "nysiris-service".to_string());
        Self {
            data_dir,
            gateway,
            label,
            address_file: None,
            write_address_file: true,
        }
    }

    /// Pin the provider to a gateway identity key.
    pub fn gateway(mut self, gateway: impl Into<String>) -> Self {
        self.gateway = Some(gateway.into());
        self
    }

    /// Override the log label.
    pub fn label(mut self, label: impl Into<String>) -> Self {
        self.label = label.into();
        self
    }

    /// Override where the address is written.
    pub fn address_file(mut self, path: impl Into<PathBuf>) -> Self {
        self.address_file = Some(path.into());
        self
    }

    /// Toggle address-file persistence.
    pub fn write_address_file(mut self, yes: bool) -> Self {
        self.write_address_file = yes;
        self
    }

    /// Path the address is written to / read from.
    pub fn address_path(&self) -> PathBuf {
        self.address_file
            .clone()
            .unwrap_or_else(|| self.data_dir.join("nym-address.txt"))
    }

    /// Persist `address` for out-of-band distribution (QR code, config, signed
    /// release). Creates the parent directory if needed.
    pub fn write_address(&self, address: &NymUri) -> std::io::Result<PathBuf> {
        let path = self.address_path();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::fs::write(&path, address.encode())?;
        Ok(path)
    }

    /// Read back a previously persisted address, if any.
    pub fn stored_address(&self) -> Result<NymUri, String> {
        let path = self.address_path();
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("no stored address at {}: {e}", path.display()))?;
        NymUri::parse(&raw).map_err(|e| e.to_string())
    }
}

/// Run `service` over `runtime` until the transport closes.
///
/// This is the whole server harness: it reuses the shared
/// [`run_loop`](provider_runtime::run_loop) and the hidden-service dispatch
/// seam, so a host never re-implements the wait/parse/validate/reply cycle.
/// Empty payloads and senders without reply SURBs are dropped, as required by
/// `docs/08-hidden-services.md`.
pub async fn serve<R, S>(runtime: &mut R, service: &S)
where
    R: MixnetRuntime,
    S: HiddenService + Send + Sync,
{
    run_loop(runtime, |message| hidden_step(service, message)).await;
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    use nym_hidden_service::{EchoService, Request, Response};

    use super::*;
    use provider_runtime::transport::{InboundMessage, SendError, SenderTag};

    struct FakeRuntime {
        batches: Mutex<VecDeque<Vec<InboundMessage>>>,
        closed: AtomicBool,
        sent: Mutex<Vec<Vec<u8>>>,
    }

    impl FakeRuntime {
        fn new(one: Vec<InboundMessage>) -> Self {
            let mut batches = VecDeque::new();
            batches.push_back(one);
            Self {
                batches: Mutex::new(batches),
                closed: AtomicBool::new(true),
                sent: Mutex::new(Vec::new()),
            }
        }
    }

    impl MixnetRuntime for FakeRuntime {
        async fn wait_for_messages(&mut self) -> Option<Vec<InboundMessage>> {
            if self.closed.load(Ordering::SeqCst) && self.batches.lock().unwrap().is_empty() {
                return None;
            }
            self.batches.lock().unwrap().pop_front()
        }

        async fn send_reply(&self, _tag: SenderTag, reply: Vec<u8>) -> Result<(), SendError> {
            self.sent.lock().unwrap().push(reply);
            Ok(())
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nysiris-sdk-host-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn env_precedence_prefers_nysiris_over_legacy() {
        let config = HostConfig::from_lookup(|key| match key {
            ENV_DATA_DIR => Some("/new/data".into()),
            ENV_DATA_DIR_LEGACY => Some("/old/data".into()),
            ENV_GATEWAY_LEGACY => Some("legacy-gw".into()),
            _ => None,
        });
        assert_eq!(config.data_dir, PathBuf::from("/new/data"));
        assert_eq!(config.gateway.as_deref(), Some("legacy-gw"));
        assert_eq!(config.label, "nysiris-service");
    }

    #[test]
    fn env_defaults_and_blank_values_fall_back() {
        let config = HostConfig::from_lookup(|_| None);
        assert_eq!(config.data_dir, PathBuf::from("./sp-storage"));
        assert_eq!(config.gateway, None);

        let blank = HostConfig::from_lookup(|key| match key {
            ENV_DATA_DIR => Some("   ".into()),
            ENV_LABEL => Some(String::new()),
            _ => None,
        });
        assert_eq!(blank.data_dir, PathBuf::from("./sp-storage"));
        assert_eq!(blank.label, "nysiris-service");
    }

    #[test]
    fn address_file_round_trips() {
        let dir = temp_dir("roundtrip");
        let config = HostConfig::new(&dir);
        assert_eq!(config.address_path(), dir.join("nym-address.txt"));

        let uri = NymUri {
            identity: [1; 32],
            encryption: [2; 32],
            gateway: [3; 32],
        };
        let written = config.write_address(&uri).expect("write address");
        assert_eq!(written, config.address_path());
        assert_eq!(config.stored_address().unwrap(), uri);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_address_file_is_an_error() {
        let dir = temp_dir("missing");
        let config = HostConfig::new(&dir);
        assert!(config.stored_address().is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn serve_answers_tagged_requests_and_stops_on_close() {
        let request = Request::new("GET", "/", std::collections::HashMap::new(), b"hi").unwrap();
        let mut runtime = FakeRuntime::new(vec![
            InboundMessage {
                message: request.to_json().into_bytes(),
                sender_tag: Some([9; 16]),
            },
            InboundMessage {
                message: Vec::new(),
                sender_tag: None,
            },
        ]);

        serve(&mut runtime, &EchoService).await;

        let sent = runtime.sent.lock().unwrap();
        assert_eq!(
            sent.len(),
            1,
            "only the tagged, non-empty request is answered"
        );
        let response = Response::from_json(&sent[0]).unwrap();
        assert_eq!(response.status, 200);
    }
}
