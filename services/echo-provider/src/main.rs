//! Pure-mixnet Nym service provider (messaging shape).
//!
//! Receives Sphinx-encrypted messages addressed to this provider's Nym
//! address and replies anonymously using the SURBs bundled by the client.
//! The provider has **no inbound port** and never learns the client's address.
//!
//! ```sh
//! SP_DATA_DIR=./sp-storage cargo run --release
//! # optional: pin to a gateway you control for a stable address
//! SP_GATEWAY=<gateway-identity-key> cargo run --release
//! ```
//!
//! Uses the `nym-sdk` 1.21.x messaging API. Replace `handle_request` with your
//! application logic.

use std::path::PathBuf;
use std::process::ExitCode;

use nym_sdk::mixnet::{MixnetClientBuilder, MixnetMessageSender, StoragePaths};
use tokio::signal;

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
    // Persistent storage => stable address across restarts. Without this the
    // address changes every run and every client config breaks.
    let data_dir = std::env::var("SP_DATA_DIR").unwrap_or_else(|_| "./sp-storage".into());
    let paths = StoragePaths::new_from_dir(PathBuf::from(&data_dir))?;

    let mut builder = MixnetClientBuilder::new_with_default_storage(paths).await?;

    // Optional: pin to a specific gateway. Required for a guaranteed-stable
    // address, because the gateway identity is part of the Nym address.
    if let Ok(gateway) = std::env::var("SP_GATEWAY") {
        println!("pinning provider to gateway {gateway}");
        builder = builder.request_gateway(gateway);
    }

    let mut client = builder.build()?.connect_to_mixnet().await?;

    let address = *client.nym_address();
    println!("\nService provider Nym address:\n{address}\n");
    // Persist for out-of-band distribution (QR code, config, signed release).
    let _ = std::fs::write("nym-address.txt", address.to_string());

    loop {
        tokio::select! {
            _ = signal::ctrl_c() => {
                println!("shutdown signal received");
                break;
            }
            maybe_messages = client.wait_for_messages() => {
                let Some(messages) = maybe_messages else { break; };

                for msg in messages {
                    // Empty messages are SURB replenishment requests handled
                    // internally by the SDK; never surface them as user data.
                    if msg.message.is_empty() {
                        continue;
                    }
                    // `sender_tag` is the SURB handle. No tag => no reply route.
                    let Some(sender_tag) = msg.sender_tag else {
                        continue;
                    };

                    let text = String::from_utf8_lossy(&msg.message);
                    println!("received {} bytes: {text:?}", msg.message.len());

                    let reply = handle_request(&msg.message);
                    if let Err(err) = client.send_reply(sender_tag, reply.as_bytes()).await {
                        eprintln!("failed to send reply: {err}");
                    } else {
                        println!("replied via SURB ({} bytes)", reply.len());
                    }
                }
            }
        }
    }

    client.disconnect().await;
    Ok(())
}

/// Application logic goes here.
///
/// Keep replies small: one regular Sphinx packet carries at most ~2031 bytes of
/// plaintext, and the reply shares the provider's ~50 packets/s send budget
/// with every other client. For larger responses use the Stream module or
/// `smolmix`, not messaging.
fn handle_request(request: &[u8]) -> String {
    let text = String::from_utf8_lossy(request);
    format!("echo: {text}")
}
