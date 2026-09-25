//! The one place in the tree that binds the shared runtime to `nym-sdk`.
//!
//! [`MixnetClientRuntime`] is the transport adapter the service crates used to
//! hand-copy: it maps the mixnet's `AnonymousSenderTag` (exactly `[u8; 16]`) to
//! the nym-free [`SenderTag`], so [`nysiris_sdk::serve`] and the CLI both work
//! over the real client without knowing `nym-sdk`.

use nym_sdk::mixnet::{MixnetClient, MixnetClientBuilder, MixnetMessageSender, StoragePaths};
use nysiris_sdk::{HostConfig, InboundMessage, MixnetRuntime, SendError, SenderTag};

use crate::CliResult;

/// Connect a mixnet client for `config`.
///
/// Persistent storage is the default and is required for a stable address
/// across restarts (`docs/04-hosting-services.md` §3.1). Pass `ephemeral` for
/// a throwaway identity (useful for one-shot `fetch` and local experiments).
pub async fn connect(config: &HostConfig, ephemeral: bool) -> CliResult<MixnetClient> {
    if ephemeral {
        return MixnetClient::connect_new()
            .await
            .map_err(|e| format!("connect_new failed: {e}"));
    }

    let paths = StoragePaths::new_from_dir(config.data_dir.clone())
        .map_err(|e| format!("storage init failed: {e}"))?;
    let mut builder = MixnetClientBuilder::new_with_default_storage(paths)
        .await
        .map_err(|e| format!("client builder failed: {e}"))?;
    if let Some(gateway) = &config.gateway {
        builder = builder.request_gateway(gateway.clone());
    }
    builder
        .build()
        .map_err(|e| format!("build failed: {e}"))?
        .connect_to_mixnet()
        .await
        .map_err(|e| format!("connect_to_mixnet failed: {e}"))
}

/// `MixnetRuntime` adapter over the real Nym client. The client is boxed in an
/// `Option` because `MixnetClient::disconnect` consumes `self`, while the
/// `&mut self` trait hook needs to take it out at teardown.
pub struct MixnetClientRuntime {
    client: Option<MixnetClient>,
}

impl MixnetClientRuntime {
    pub fn new(client: MixnetClient) -> Self {
        Self {
            client: Some(client),
        }
    }
}

impl MixnetRuntime for MixnetClientRuntime {
    async fn wait_for_messages(&mut self) -> Option<Vec<InboundMessage>> {
        let client = self.client.as_mut()?;
        client.wait_for_messages().await.map(|batch| {
            batch
                .into_iter()
                .map(|message| InboundMessage {
                    message: message.message,
                    sender_tag: message.sender_tag.map(|tag| tag.to_bytes()),
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
            .send_reply(
                nym_sdk::mixnet::AnonymousSenderTag::from_bytes(sender_tag),
                reply,
            )
            .await
            .map_err(|e| SendError(e.to_string()))
    }

    async fn disconnect(&mut self) {
        if let Some(client) = self.client.take() {
            client.disconnect().await;
        }
    }
}
