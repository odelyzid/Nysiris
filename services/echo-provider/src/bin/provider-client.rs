//! Minimal mixnet client: send one message to a Nym address and print the
//! anonymous SURB reply.
//!
//! ```sh
//! cargo run --release --bin provider-client -- <nym-address> ["message"]
//! ```
//!
//! Demonstrates "host a service, reach it over the mixnet": `echo-provider`
//! runs elsewhere with no inbound ports, and this client reaches it purely by
//! Nym address. Uses persistent storage by default (matching the acceptance
//! test path); set `CLIENT_EPHEMERAL=1` for a throwaway identity.

use std::path::PathBuf;
use std::time::Duration;

use nym_sdk::mixnet::{
    MixnetClient, MixnetClientBuilder, MixnetMessageSender, Recipient, StoragePaths,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    nym_bin_common::logging::setup_tracing_logger();

    let raw = std::env::args()
        .nth(1)
        .expect("usage: provider-client <nym-address> [message]");
    let message = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "hello from a mixnet client".to_string());

    let recipient: Recipient = raw.trim().parse()?;
    println!("provider: {recipient}");

    let mut client = connect().await?;
    println!("client address: {}", client.nym_address());

    let started = std::time::Instant::now();
    client.send_plain_message(recipient, message.clone()).await?;
    println!("sent in {:?}: {message:?}", started.elapsed());

    let reply = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            if let Some(messages) = client.wait_for_messages().await {
                if let Some(m) = messages.into_iter().find(|m| !m.message.is_empty()) {
                    return m;
                }
            }
        }
    })
    .await
    .map_err(|_| "timed out waiting for the anonymous reply")?;

    println!(
        "anonymous reply in {:?}: {:?}",
        started.elapsed(),
        String::from_utf8_lossy(&reply.message)
    );

    client.disconnect().await;
    Ok(())
}

async fn connect() -> Result<MixnetClient, Box<dyn std::error::Error>> {
    if std::env::var("CLIENT_EPHEMERAL").is_ok() {
        return Ok(MixnetClient::connect_new().await?);
    }
    let dir = std::env::var("CLIENT_STORAGE").unwrap_or_else(|_| "./client-storage".into());
    let paths = StoragePaths::new_from_dir(PathBuf::from(&dir))?;
    let client = MixnetClientBuilder::new_with_default_storage(paths)
        .await?
        .build()?
        .connect_to_mixnet()
        .await?;
    Ok(client)
}
