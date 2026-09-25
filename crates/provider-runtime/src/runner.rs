//! Provider request loop.
//!
//! [`run_loop`] pulls batches from the transport and runs a per-message
//! handler; [`hidden_step`] is that handler for hidden services (the
//! `nym_hidden_service::{HiddenService, dispatch}` seam), shared verbatim by
//! every hidden-service provider binary.

use crate::transport::{InboundMessage, MixnetRuntime, Outbound};

/// Hidden-service message step: one inbound message through
/// `nym_hidden_service::dispatch`, packaged for [`run_loop`].
///
/// Empty payloads — and senders that left no reply tag (no SURBs), which
/// nothing can be answered — are dropped silently, exactly what the
/// per-service loops did inline before.
pub async fn hidden_step<S>(service: &S, msg: InboundMessage) -> Option<Outbound>
where
    S: nym_hidden_service::HiddenService + Send + Sync,
{
    if msg.message.is_empty() {
        return None;
    }
    let sender_tag = msg.sender_tag?;
    let reply = nym_hidden_service::dispatch(service, &msg.message);
    Some(Outbound { sender_tag, reply })
}

/// Run a provider's request loop until the transport closes. `handler` turns
/// each inbound message into an optional reply; `None` (empty payload, no
/// SURB tag, deliberate drop) sends nothing.
///
/// A failed reply is logged and the loop keeps serving the rest of the batch —
/// the transport may have disappeared mid-batch, but the other senders are
/// still reachable. When the transport closes the loop calls
/// [`MixnetRuntime::disconnect`] and returns.
pub async fn run_loop<R, H, Fut>(transport: &mut R, mut handler: H)
where
    R: MixnetRuntime,
    H: FnMut(InboundMessage) -> Fut,
    Fut: std::future::Future<Output = Option<Outbound>>,
{
    while let Some(messages) = transport.wait_for_messages().await {
        for msg in messages {
            let Some(outbound) = handler(msg).await else {
                continue;
            };
            if let Err(err) = transport
                .send_reply(outbound.sender_tag, outbound.reply)
                .await
            {
                eprintln!("provider-runtime: failed to send reply: {err}");
            }
        }
    }
    transport.disconnect().await;
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    use nym_hidden_service::{EchoService, Request};

    use super::*;
    use crate::transport::SendError;
    use crate::SenderTag;

    fn envelope(payload: &[u8]) -> Vec<u8> {
        Request::new("GET", "/", HashMap::new(), payload)
            .expect("test payloads pass the open-proxy guards")
            .to_json()
            .into_bytes()
    }

    fn tagged(payload: &[u8], tag: u8) -> InboundMessage {
        InboundMessage {
            message: envelope(payload),
            sender_tag: Some([tag; 16]),
        }
    }

    fn tagless(payload: &[u8]) -> InboundMessage {
        InboundMessage {
            message: payload.to_vec(),
            sender_tag: None,
        }
    }

    /// Deterministic transport fake: a queue of batches, a stop flag, and
    /// a record of everything sent/disconnected.
    struct FakeRuntime {
        batches: Mutex<VecDeque<Vec<InboundMessage>>>,
        closed: AtomicBool,
        fail_sends: AtomicUsize,
        sent: Mutex<Vec<(SenderTag, Vec<u8>)>>,
        disconnects: AtomicUsize,
    }

    impl FakeRuntime {
        fn new() -> Self {
            Self {
                batches: Mutex::new(VecDeque::new()),
                closed: AtomicBool::new(false),
                fail_sends: AtomicUsize::new(0),
                sent: Mutex::new(Vec::new()),
                disconnects: AtomicUsize::new(0),
            }
        }

        fn offer(&self, batch: Vec<InboundMessage>) {
            self.batches.lock().unwrap().push_back(batch);
        }

        fn close(&self) {
            self.closed.store(true, Ordering::SeqCst);
        }

        /// Make the next `n` send attempts fail (transport gone mid-batch).
        fn fail_next_sends(&self, n: usize) {
            self.fail_sends.store(n, Ordering::SeqCst);
        }

        fn sent(&self) -> Vec<(SenderTag, Vec<u8>)> {
            self.sent.lock().unwrap().clone()
        }
    }

    impl MixnetRuntime for FakeRuntime {
        async fn wait_for_messages(&mut self) -> Option<Vec<InboundMessage>> {
            // Drain queued batches, then report the transport as closed.
            if self.closed.load(Ordering::SeqCst) && self.batches.lock().unwrap().is_empty() {
                return None;
            }
            self.batches.lock().unwrap().pop_front()
        }

        async fn send_reply(&self, sender_tag: SenderTag, reply: Vec<u8>) -> Result<(), SendError> {
            if self.fail_sends.load(Ordering::SeqCst) > 0 {
                self.fail_sends.fetch_sub(1, Ordering::SeqCst);
                return Err(SendError("nope".into()));
            }
            self.sent.lock().unwrap().push((sender_tag, reply));
            Ok(())
        }

        async fn disconnect(&mut self) {
            self.disconnects.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn run_loop_answers_tagged_messages_and_drops_the_rest() {
        let mut fake = FakeRuntime::new();
        fake.offer(vec![
            tagged(b"hi", 1),
            tagless(b"no surbs"),
            InboundMessage {
                message: Vec::new(),
                sender_tag: Some([2; 16]),
            },
            tagged(b"hello", 3),
        ]);
        fake.close();

        run_loop(&mut fake, |m| hidden_step(&EchoService, m)).await;

        let sent = fake.sent();
        assert_eq!(
            sent.len(),
            2,
            "empty + tagless messages must not be answered"
        );
        assert_eq!(sent[0].0, [1; 16]);
        assert_eq!(sent[1].0, [3; 16]);
        for (_, reply) in &sent {
            let response = nym_hidden_service::Response::from_json(reply)
                .expect("hidden_step replies are serialized envelope responses");
            assert_eq!(response.status, 200, "echo dispatch returns an ok response");
        }
        assert_eq!(fake.disconnects.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn run_loop_exits_and_disconnects_when_transport_closes() {
        let mut fake = FakeRuntime::new();
        fake.offer(vec![tagged(b"one", 7)]);
        fake.close();

        run_loop(&mut fake, |m| hidden_step(&EchoService, m)).await;
        // The loop consumed the batch, then saw the close.
        assert_eq!(fake.sent().len(), 1);
        assert_eq!(fake.disconnects.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn run_loop_keeps_serving_after_a_send_failure() {
        let mut fake = FakeRuntime::new();
        fake.offer(vec![tagged(b"a", 1), tagged(b"b", 2), tagged(b"c", 3)]);
        fake.fail_next_sends(1);
        fake.close();

        run_loop(&mut fake, |m| hidden_step(&EchoService, m)).await;

        let sent = fake.sent();
        assert_eq!(sent.len(), 2, "only the sabotaged reply is lost");
        assert_eq!(sent[0].0, [2; 16]);
        assert_eq!(sent[1].0, [3; 16]);
    }

    #[tokio::test]
    async fn run_loop_returns_immediately_when_already_closed() {
        let mut fake = FakeRuntime::new();
        fake.close();

        run_loop(&mut fake, |m| hidden_step(&EchoService, m)).await;

        assert!(fake.sent().is_empty());
        assert_eq!(fake.disconnects.load(Ordering::SeqCst), 1);
    }
}
