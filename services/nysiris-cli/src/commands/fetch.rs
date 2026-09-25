//! `nysiris fetch` — send a hidden-service request envelope to a service over
//! the mixnet and print its reply. The client-side counterpart to `host`,
//! useful for verifying a freshly hosted service without the browser.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use nym_sdk::mixnet::{MixnetMessageSender, Recipient};
use nysiris_sdk::{NymUri, PetnameRegistry, Request, Response};

use crate::args::FetchArgs;
use crate::commands::host_config;
use crate::runtime;
use crate::CliResult;

pub async fn run(args: FetchArgs) -> CliResult<()> {
    let target = resolve_target(&args)?;
    let recipient: Recipient = target
        .encode()
        .parse()
        .map_err(|e| format!("could not parse `{target}` as a Nym address: {e}"))?;

    let body = args.body.as_deref().map(str::as_bytes).unwrap_or(&[]);
    let request = Request::new(&args.method, &args.path, HashMap::new(), body)
        .map_err(|e| format!("request rejected by the open-proxy guards: {e}"))?;
    let envelope = request.to_json().into_bytes();

    let mut config = host_config(&args.common);
    // One-shot reads do not need an identity of their own: use an ephemeral
    // client unless the operator asked for persistent storage.
    let ephemeral = args.ephemeral || args.common.data_dir.is_none();
    if ephemeral {
        config.write_address_file = false;
    }

    eprintln!("connecting to the mixnet (this can take a few seconds)…");
    let mut client = runtime::connect(&config, ephemeral).await?;

    let started = Instant::now();
    client
        .send_plain_message(recipient, envelope)
        .await
        .map_err(|e| format!("send failed: {e}"))?;
    println!("sent {} {} to {target}", args.method, args.path);

    let reply = tokio::time::timeout(Duration::from_secs(args.timeout_secs), async {
        loop {
            if let Some(messages) = client.wait_for_messages().await {
                if let Some(message) = messages.into_iter().find(|m| !m.message.is_empty()) {
                    return message;
                }
            }
        }
    })
    .await
    .map_err(|_| format!("timed out after {}s waiting for a reply", args.timeout_secs))?;
    let elapsed = started.elapsed();

    client.disconnect().await;
    print_response(&reply.message, elapsed)
}

/// Resolve a petname to an address, or parse the target as a raw address.
fn resolve_target(args: &FetchArgs) -> CliResult<NymUri> {
    let path = petnames_path(args);
    if path.exists() {
        let registry = PetnameRegistry::load(&path)?;
        return registry.resolve(&args.target);
    }
    NymUri::parse(&args.target).map_err(|e| e.to_string())
}

/// Petname file: `--petnames`, else `<data-dir>/petnames.json`.
fn petnames_path(args: &FetchArgs) -> PathBuf {
    if let Some(file) = &args.petnames {
        return PathBuf::from(file);
    }
    let dir = args
        .common
        .data_dir
        .clone()
        .or_else(|| std::env::var(nysiris_sdk::host::ENV_DATA_DIR).ok())
        .or_else(|| std::env::var(nysiris_sdk::host::ENV_DATA_DIR_LEGACY).ok())
        .unwrap_or_else(|| "./sp-storage".to_string());
    Path::new(&dir).join("petnames.json")
}

fn print_response(raw: &[u8], elapsed: Duration) -> CliResult<()> {
    match Response::from_json(raw) {
        Ok(response) => {
            println!("status: {} ({} ms)", response.status, elapsed.as_millis());
            let mut headers: Vec<_> = response.headers.iter().collect();
            headers.sort();
            for (name, value) in headers {
                println!("{name}: {value}");
            }
            if let Some(error) = &response.error {
                println!("error: {error}");
            }
            let body = response.body()?;
            if body.is_empty() {
                println!("(empty body)");
            } else if let Ok(text) = std::str::from_utf8(&body) {
                println!("\n{text}");
            } else {
                println!("\n<{} binary bytes>", body.len());
            }
            Ok(())
        }
        Err(err) => {
            eprintln!("reply is not a hidden-service envelope: {err}");
            match std::str::from_utf8(raw) {
                Ok(text) => println!("{text}"),
                Err(_) => println!("<{} raw bytes>", raw.len()),
            }
            Ok(())
        }
    }
}
