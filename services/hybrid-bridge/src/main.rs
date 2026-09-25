//! Hybrid hosting bridge: accepts Nym mixnet requests and forwards them to a
//! local clearnet backend (nginx, Caddy, your app).
//!
//! ```text
//! clearnet users ──▶ Caddy :443 ─────────────────────┐
//!                                                    ├──▶ app (compose network)
//! mixnet clients ──▶ this bridge (embedded nym client)┘
//! ```
//!
//! This is **not** an exit gateway: the bridge is an ordinary Nym client, so it
//! has no outproxy policy or exit liability. It only talks to `BACKEND_URL`.
//!
//! Request/response are small JSON envelopes so the transport stays opaque
//! bytes and the backend stays Nym-unaware:
//!
//! ```json
//! { "method": "GET", "path": "/api/status", "headers": {}, "body_base64": "" }
//! ```
//!
//! All open-proxy guards live in the `bridge-guard` crate and are unit-tested
//! in the fast workspace loop (`cargo test -p bridge-guard`). This file only
//! performs I/O; it does not re-implement the policy.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use bridge_guard::{validate, RequestSpec, DEFAULT_MAX_BODY_BYTES};
use nym_sdk::mixnet::{MixnetClient, MixnetClientBuilder, MixnetMessageSender, StoragePaths};
use provider_runtime::{run_loop, InboundMessage, MixnetRuntime, Outbound, SendError, SenderTag};
use serde::{Deserialize, Serialize};
use tokio::signal;

#[derive(Deserialize)]
struct RequestEnvelope {
    method: String,
    path: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body_base64: String,
}

#[derive(Serialize)]
struct ResponseEnvelope {
    status: u16,
    headers: HashMap<String, String>,
    body_base64: String,
    error: Option<String>,
}

#[tokio::main]
async fn main() -> ExitCode {
    nym_bin_common::logging::setup_tracing_logger();
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("fatal: {err}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let backend = std::env::var("BACKEND_URL").unwrap_or_else(|_| "http://app:80".into());
    let data_dir = std::env::var("SP_DATA_DIR").unwrap_or_else(|_| "./bridge-storage".into());

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        // Never follow redirects to arbitrary hosts from a mixnet request.
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

    let paths = StoragePaths::new_from_dir(PathBuf::from(&data_dir))?;
    let mut builder = MixnetClientBuilder::new_with_default_storage(paths).await?;
    if let Ok(gateway) = std::env::var("SP_GATEWAY") {
        builder = builder.request_gateway(gateway);
    }
    let client = builder.build()?.connect_to_mixnet().await?;

    let address = *client.nym_address();
    println!("\nHybrid bridge Nym address:\n{address}\n");
    println!("Forwarding to backend: {backend}\n");

    let mut runtime = MixnetClientRuntime {
        client: Some(client),
    };
    // provider_runtime::run_loop answers tagged bridge requests until the
    // transport closes; ctrl_c tears down gracefully either way.
    let mut serve = Box::pin(run_loop(&mut runtime, |msg| {
        bridge_step(&http, &backend, msg)
    }));
    tokio::select! {
        _ = signal::ctrl_c() => {
            println!("shutdown signal received");
            drop(serve);
            runtime.disconnect().await;
        }
        _ = &mut serve => {}
    }

    Ok(())
}

/// One inbound message through the backend bridge, packaged for [`run_loop`]:
/// empty payloads (and senders without reply SURBs) are dropped unchanged.
async fn bridge_step(
    http: &reqwest::Client,
    backend: &str,
    msg: InboundMessage,
) -> Option<Outbound> {
    if msg.message.is_empty() {
        return None;
    }
    let sender_tag = msg.sender_tag?;
    let response = handle(http, backend, &msg.message).await;
    let bytes = serde_json::to_vec(&response).unwrap_or_default();
    Some(Outbound {
        sender_tag,
        reply: bytes,
    })
}

/// `MixnetRuntime` adapter over the real Nym client: the shared loop in
/// provider-runtime stays nym-free, this bit maps its SenderTag ↔
/// `AnonymousSenderTag` (both exactly `[u8; 16]`). The client is boxed in an
/// `Option` because `MixnetClient::disconnect` consumes — the `&mut self`
/// trait hook takes it out at teardown.
struct MixnetClientRuntime {
    client: Option<MixnetClient>,
}

impl MixnetRuntime for MixnetClientRuntime {
    async fn wait_for_messages(&mut self) -> Option<Vec<InboundMessage>> {
        let client = self.client.as_mut()?;
        client.wait_for_messages().await.map(|batch| {
            batch
                .into_iter()
                .map(|msg| InboundMessage {
                    message: msg.message,
                    sender_tag: msg.sender_tag.map(|tag| tag.to_bytes()),
                })
                .collect()
        })
    }

    async fn send_reply(&self, sender_tag: SenderTag, reply: Vec<u8>) -> Result<(), SendError> {
        let client = self
            .client
            .as_ref()
            .ok_or_else(|| SendError("client already disconnected".into()))?;
        client
            .send_reply(nym_sdk::mixnet::AnonymousSenderTag::from_bytes(sender_tag), reply)
            .await
            .map_err(|err| SendError(err.to_string()))
    }

    async fn disconnect(&mut self) {
        if let Some(client) = self.client.take() {
            client.disconnect().await;
        }
    }
}

async fn handle(http: &reqwest::Client, backend: &str, raw: &[u8]) -> ResponseEnvelope {
    let envelope: RequestEnvelope = match serde_json::from_slice(raw) {
        Ok(envelope) => envelope,
        Err(err) => return error_response(format!("bad request envelope: {err}")),
    };

    let body = match B64.decode(&envelope.body_base64) {
        Ok(body) => body,
        Err(err) => return error_response(format!("body_base64 invalid: {err}")),
    };

    // Every open-proxy guard is enforced here (bridge-guard, unit-tested).
    let headers: Vec<(&str, &str)> = envelope
        .headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let spec = RequestSpec::new(&envelope.method, &envelope.path, body.len(), &headers);
    let validated = match validate(spec, DEFAULT_MAX_BODY_BYTES) {
        Ok(validated) => validated,
        Err(err) => return error_response(format!("request rejected: {err}")),
    };

    let url = format!("{}{}", backend.trim_end_matches('/'), validated.path);
    let method = match reqwest::Method::from_bytes(validated.method.as_bytes()) {
        Ok(m) => m,
        Err(err) => return error_response(format!("invalid method: {err}")),
    };

    let mut request = http.request(method, &url);
    // Only the allow-listed headers survive `validate` (no auth/cookie/host).
    for (name, value) in &validated.forwarded_headers {
        request = request.header(name, value);
    }
    if !body.is_empty() {
        request = request.body(body);
    }

    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let mut headers = HashMap::new();
            if let Some(ct) = response.headers().get("content-type") {
                if let Ok(ct) = ct.to_str() {
                    headers.insert("content-type".into(), ct.to_string());
                }
            }
            let bytes = response.bytes().await.unwrap_or_default();
            ResponseEnvelope {
                status,
                headers,
                body_base64: B64.encode(&bytes),
                error: None,
            }
        }
        Err(err) => error_response(format!("backend request failed: {err}")),
    }
}

fn error_response(message: String) -> ResponseEnvelope {
    ResponseEnvelope {
        status: 502,
        headers: HashMap::new(),
        body_base64: String::new(),
        error: Some(message),
    }
}
