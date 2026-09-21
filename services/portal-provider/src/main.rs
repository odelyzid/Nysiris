//! portal-provider: content-addressed object + log storage, verification only.
//!
//! ```sh
//! SP_DATA_DIR=./sp-storage PORTAL_DB=./portal.sqlite cargo run --release
//! # SP_GATEWAY=<gateway-identity-key>  # optional: pin for a stable address
//! ```
//!
//! No inbound ports. Sync is client-driven: browsers fetch `/heads`, compute
//! wants, pull `/log/<author>?since=n`, and converge locally. See
//! `docs/10-portal.md`.

mod service;
mod store;

use std::path::PathBuf;
use std::process::ExitCode;

use nym_hidden_service::dispatch;
use nym_sdk::mixnet::{MixnetClientBuilder, MixnetMessageSender, StoragePaths};

use crate::service::PortalService;
use crate::store::Store;

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
    let data_dir = std::env::var("SP_DATA_DIR").unwrap_or_else(|_| "./sp-storage".into());
    let db_path = std::env::var("PORTAL_DB").unwrap_or_else(|_| "./portal.sqlite".into());

    let store = Store::open(&PathBuf::from(&db_path))?;
    // Spam backstops (docs/10-portal.md §10.5): optional PoW difficulty and a
    // per-author daily budget. Defaults keep the provider open; raise them
    // when abuse appears. Rate state is in-memory (resets on restart).
    let pow_bits = std::env::var("PORTAL_POW_BITS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let rate_per_day = std::env::var("PORTAL_RATE_PER_DAY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(500);
    let service = PortalService::with_limits(
        store,
        pow_bits,
        portal_reputation::rate::RatePolicy {
            max_per_day: rate_per_day,
        },
    );

    let paths = StoragePaths::new_from_dir(PathBuf::from(&data_dir))?;
    let mut builder = MixnetClientBuilder::new_with_default_storage(paths).await?;
    if let Ok(gateway) = std::env::var("SP_GATEWAY") {
        println!("pinning provider to gateway {gateway}");
        builder = builder.request_gateway(gateway);
    }
    let mut client = builder.build()?.connect_to_mixnet().await?;

    let address = *client.nym_address();
    println!("\nportal-provider Nym address:\n{address}\n");
    let _ = std::fs::write("nym-address.txt", address.to_string());

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                println!("shutdown signal received");
                break;
            }
            maybe_messages = client.wait_for_messages() => {
                let Some(messages) = maybe_messages else { break; };
                for msg in messages {
                    if msg.message.is_empty() { continue; }
                    let Some(tag) = msg.sender_tag else { continue; };
                    let reply = dispatch(&service, &msg.message);
                    if let Err(err) = client.send_reply(tag, reply).await {
                        eprintln!("failed to send reply: {err}");
                    }
                }
            }
        }
    }

    client.disconnect().await;
    Ok(())
}
