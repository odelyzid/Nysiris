//! fly-social provider: metadata-minimal microblog + DM dead-drop hidden service.
//!
//! ```sh
//! SP_DATA_DIR=./sp-storage SOCIAL_DB=./social.sqlite cargo run --release
//! # SP_GATEWAY=<gateway-identity-key>  # optional: pin for a stable address
//! # SOCIAL_POW_BITS=16 SOCIAL_RATE_PER_DAY=200  # optional spam backstops
//! ```
//!
//! No inbound ports. Clients reach it only by Nym address; replies go back
//! over SURBs. See `docs/09-social.md`.

mod service;
mod sig;
mod store;

use std::path::PathBuf;
use std::process::ExitCode;

use nym_hidden_service::dispatch;
use nym_sdk::mixnet::{MixnetClientBuilder, MixnetMessageSender, StoragePaths};

use crate::service::SocialService;
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
    let db_path = std::env::var("SOCIAL_DB").unwrap_or_else(|_| "./social.sqlite".into());

    let store = Store::open(&PathBuf::from(&db_path))?;
    // Spam backstops (docs/10-portal.md §10.5): optional PoW difficulty
    // (advertised in GET /, proven client-side) plus a per-author daily
    // budget. Defaults keep the service open; raise them under abuse.
    // Rate state is in-memory and resets on restart.
    let pow_bits = std::env::var("SOCIAL_POW_BITS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let rate_per_day = std::env::var("SOCIAL_RATE_PER_DAY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(500);
    let service = SocialService::with_limits(
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
    println!("\nfly-social Nym address:\n{address}\n");
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
