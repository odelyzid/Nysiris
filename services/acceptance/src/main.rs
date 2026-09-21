//! Live-network acceptance test for the Nym mixnet integration.
//!
//! Proves, against the real network, the two properties the whole design rests
//! on:
//!
//! 1. **Delivery** — a message sent to a Nym address arrives (the 5-hop Sphinx
//!    path works end to end).
//! 2. **Anonymous replies** — the recipient can reply using the SURBs bundled
//!    with the message, without ever learning the sender's address
//!    (`docs/05-security.md` §5.3).
//!
//! It sends a message to *itself*, receives it, extracts the `sender_tag`, and
//! replies over SURBs.
//!
//! ```sh
//! ./build.sh acceptance
//! # or directly:
//! ACCEPTANCE_STORAGE=./acceptance-storage cargo run --release
//! ACCEPTANCE_EPHEMERAL=1 cargo run --release     # throwaway identity
//! ACCEPTANCE_DEADLINE_SECS=180 cargo run --release
//! ```

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use nym_sdk::mixnet::{
    MixnetClient, MixnetClientBuilder, MixnetMessageSender, ReconstructedMessage, StoragePaths,
};
use tokio::time::timeout;

type AResult<T> = Result<T, String>;

fn deadline() -> Duration {
    let secs = std::env::var("ACCEPTANCE_DEADLINE_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(180);
    Duration::from_secs(secs)
}

#[tokio::main]
async fn main() -> ExitCode {
    nym_bin_common::logging::setup_tracing_logger();
    match run().await {
        Ok(()) => {
            println!("\nACCEPTANCE: PASS");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("\nACCEPTANCE: FAIL — {err}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> AResult<()> {
    let ephemeral = std::env::var("ACCEPTANCE_EPHEMERAL").is_ok_and(|v| v == "1");
    let mut client = connect(ephemeral).await?;

    let address = *client.nym_address();
    println!("connected as {address}");
    println!("(ephemeral = {ephemeral}, deadline = {:?})", deadline());

    // --- 1. Delivery: send to self and receive. ---------------------------
    let ping = format!("acceptance ping {}", now_millis());
    let started = Instant::now();
    client
        .send_plain_message(address, ping.clone())
        .await
        .map_err(|e| format!("send_plain_message failed: {e}"))?;
    println!("sent ping, waiting for delivery…");

    let received = wait_for_nonempty(&mut client, "self-message").await?;
    let rtt = started.elapsed();
    let got = String::from_utf8(received.message.clone())
        .map_err(|e| format!("received non-UTF8 payload: {e}"))?;
    if got != ping {
        return Err(format!("payload mismatch: sent {ping:?}, received {got:?}"));
    }
    println!("delivered in {rtt:?}: {got:?}");

    // --- 2. Anonymous reply via SURBs. ------------------------------------
    let sender_tag = received
        .sender_tag
        .ok_or("incoming message carried no sender_tag (SURB bundle missing)")?;
    println!("got sender_tag {sender_tag}; replying over SURBs…");

    let pong = format!("acceptance pong {}", now_millis());
    let reply_started = Instant::now();
    client
        .send_reply(sender_tag, pong.clone())
        .await
        .map_err(|e| format!("send_reply failed: {e}"))?;

    let reply = wait_for_nonempty(&mut client, "SURB reply").await?;
    let reply_rtt = reply_started.elapsed();
    let reply_text =
        String::from_utf8(reply.message).map_err(|e| format!("reply non-UTF8: {e}"))?;
    if reply_text != pong {
        return Err(format!("reply mismatch: sent {pong:?}, received {reply_text:?}"));
    }
    println!("SURB reply received in {reply_rtt:?}: {reply_text:?}");

    // --- Summary ----------------------------------------------------------
    println!("\nmetrics:");
    println!("  delivery_rtt_ms = {}", rtt.as_millis());
    println!("  surb_reply_rtt_ms = {}", reply_rtt.as_millis());
    println!("  hop_model = entry -> 3 mix layers -> destination gateway (5 Sphinx hops)");

    client.disconnect().await;
    Ok(())
}

async fn connect(ephemeral: bool) -> AResult<MixnetClient> {
    if ephemeral {
        return MixnetClient::connect_new()
            .await
            .map_err(|e| format!("connect_new failed: {e}"));
    }

    let dir = std::env::var("ACCEPTANCE_STORAGE").unwrap_or_else(|_| "./acceptance-storage".into());
    println!("using persistent storage at {dir} (set ACCEPTANCE_EPHEMERAL=1 to skip)");
    let paths = StoragePaths::new_from_dir(PathBuf::from(&dir))
        .map_err(|e| format!("storage init failed: {e}"))?;
    let builder = MixnetClientBuilder::new_with_default_storage(paths)
        .await
        .map_err(|e| format!("client builder failed: {e}"))?;
    builder
        .build()
        .map_err(|e| format!("build failed: {e}"))?
        .connect_to_mixnet()
        .await
        .map_err(|e| format!("connect_to_mixnet failed: {e}"))
}

/// Wait for the next non-empty message, defensively skipping the empty messages
/// the SDK uses for internal SURB replenishment.
async fn wait_for_nonempty(client: &mut MixnetClient, label: &str) -> AResult<ReconstructedMessage> {
    let wait = async {
        loop {
            if let Some(messages) = client.wait_for_messages().await {
                if let Some(message) = messages.into_iter().find(|m| !m.message.is_empty()) {
                    return message;
                }
            }
        }
    };

    timeout(deadline(), wait)
        .await
        .map_err(|_| format!("timed out after {:?} waiting for {label}", deadline()))
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
