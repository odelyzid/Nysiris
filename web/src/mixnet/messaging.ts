/**
 * Pure-mixnet messaging by Nym address, with anonymous SURB replies.
 *
 * Uses `@nymproject/sdk-full-fat`, which inlines the WASM + Web Worker as
 * Base64 so Android/TWA builds need no bundler configuration. The SDK persists
 * client identity in IndexedDB; clear it to force a fresh identity (also the
 * fix for a stuck gateway handshake).
 *
 * SDK quirks (sdk-full-fat 1.x, WASM 1.4.1 — expected console noise, not bugs):
 * * `__wbg_init: using deprecated parameters…` comes from Nym's own
 *   wasm-bindgen glue. Harmless; only an SDK upgrade removes it.
 * * `Failed to parse binary message … Did you pass the entire message…`
 *   is logged by the worker for every raw (non-mime) inbound message: it
 *   emits `RawMessageReceived` first (which we consume), then tries a mime
 *   decode that fails for `rawSend` payloads and Rust `send_reply` bytes.
 *   The huge "Metadata size" is raw JSON bytes misread as a length prefix
 *   (e.g. 0x61747573 = "atus"). The message itself is already delivered.
 *
 * Security (docs/05-security.md):
 * * inbound replies are deduplicated and aged out (§5.3.1 single-use, §5.3.3 TTL),
 * * outbound replies are rate-limited so one conversation cannot exhaust the
 *   shared send budget (§5.3.4).
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- the SDK surface is wide
   and versioned; we keep a thin typed wrapper around the documented calls. */
import { ReplyBudget, ReplyTracker, messageKey } from './enforcement.mjs';

export interface IncomingMessage {
  text: string;
  /**
   * Present when the sender bundled SURBs, enabling an anonymous reply.
   * Always `undefined` with sdk-full-fat 1.x: the worker surfaces no sender
   * tag, so provider-to-browser replies (Rust `send_reply`, correlated by
   * envelope content as in `fetchNym`) work, but browser-to-browser SURB
   * replies do not.
   */
  senderTag?: string;
  raw?: unknown;
}

export class NymAddressClient {
  private nym: any;
  private started = false;
  private address = '';
  /** §5.3.1/§5.3.3: dedupe + expire inbound replies. */
  private readonly inbound = new ReplyTracker();
  /** §5.3.4: burst of 20, then 2 replies/second sustained. */
  private readonly replies = new ReplyBudget(20, 2);

  /** Connect and return this client's own Nym address. Idempotent. */
  async start(
    nymApiUrl: string,
    onMessage: (message: IncomingMessage) => void,
    onRejected?: (reason: string) => void,
  ): Promise<string> {
    if (this.started) return this.address;

    const { createNymMixnetClient } = await import('@nymproject/sdk-full-fat');
    this.nym = await createNymMixnetClient();

    const deliver = (text: string, senderTag: string | undefined, raw: unknown) => {
      // §5.3.1: never process the same reply twice.
      const key = messageKey(senderTag, text);
      if (!this.inbound.accept(key)) {
        onRejected?.('duplicate reply ignored');
        return;
      }
      onMessage({ text, senderTag, raw });
    };

    // Well-formed mime-typed messages (from other TypeScript SDK clients).
    this.nym.events.subscribeToTextMessageReceivedEvent((event: any) => {
      deliver(String(event.args?.payload ?? ''), event.args?.senderTag, event.args);
    });

    // Mime-framed binary payloads (e.g. `application/octet-stream` from a
    // TypeScript peer using `send`). Decoded as UTF-8 like the raw path.
    this.nym.events.subscribeToBinaryMessageReceivedEvent?.((event: any) => {
      const bytes: Uint8Array | undefined = event.args?.payload;
      if (!bytes) return;
      deliver(new TextDecoder().decode(bytes), event.args?.senderTag, event.args);
    });

    // Raw bytes with no mime envelope. This is how a Rust SDK peer (e.g. the
    // hybrid-bridge) replies: `send_reply` sends raw bytes, and the worker
    // logs "Failed to parse binary message" when its mime decode attempt
    // fails — the raw payload here is already the complete message.
    this.nym.events.subscribeToRawMessageReceivedEvent?.((event: any) => {
      const bytes: Uint8Array | undefined = event.args?.payload;
      if (!bytes) return;
      deliver(new TextDecoder().decode(bytes), event.args?.senderTag, event.args);
    });

    // The worker posts `Connected` with the address once the gateway
    // handshake completes. Waiting for it avoids polling `selfAddress()`,
    // where every miss logs "Client has not been initialised" from the
    // worker and returns `undefined`.
    const connectedAddress = new Promise<string>((resolve) => {
      this.nym.events.subscribeToConnected((event: any) => {
        const value = event?.args?.address;
        if (typeof value === 'string' && value.length > 0) resolve(value);
      });
    });

    await this.nym.client.start({
      clientId: crypto.randomUUID(),
      nymApiUrl,
      // WSS to the entry gateway; required on HTTPS pages.
      forceTls: true,
    });

    const timeoutMs = 60_000;
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('client started but Connected address never arrived')), timeoutMs);
    });
    this.address = await Promise.race([connectedAddress, timeout]);
    // Fallback: some SDK builds post `Connected` without an address. One
    // direct read is cheaper (and quieter) than the old 30× poll loop.
    if (!this.address && typeof this.nym.client.selfAddress === 'function') {
      const value = await this.nym.client.selfAddress();
      if (typeof value === 'string' && value.length > 0) this.address = value;
    }
    if (!this.address) {
      throw new Error('client started but Connected address stayed empty');
    }
    this.started = true;
    return this.address;
  }

  /** Send to a `<identity>.<encryption>@<gateway>` address. SURBs are bundled automatically. */
  async send(recipient: string, message: string): Promise<void> {
    this.assertStarted();
    // Send raw UTF-8 so non-TypeScript peers (the Rust SDK / service providers)
    // receive the message text rather than this SDK's mime envelope.
    if (typeof this.nym.client.rawSend === 'function') {
      await this.nym.client.rawSend({
        payload: new TextEncoder().encode(message),
        recipient,
      });
      return;
    }
    await this.nym.client.send({
      payload: { message, mimeType: 'text/plain' },
      recipient,
    });
  }

  /**
   * Reply without learning the sender's address: consumes one SURB.
   *
   * Unavailable with sdk-full-fat 1.x: the worker exposes no `replyWithSurb`
   * and never surfaces a `senderTag`, so this always throws. Kept as an
   * explicit failure (rather than calling an undefined method) so a future
   * SDK upgrade has a single place to wire the real reply path.
   */
  async reply(senderTag: string, message: string): Promise<void> {
    this.assertStarted();
    if (typeof this.nym.client.replyWithSurb !== 'function') {
      throw new Error('this SDK build does not expose replyWithSurb; anonymous SURB replies are unavailable');
    }
    if (!this.replies.tryTake()) {
      throw new Error('reply budget exhausted; slow down to protect the shared send budget');
    }
    await this.nym.client.replyWithSurb({
      senderTag,
      payload: { message, mimeType: 'text/plain' },
    });
  }

  /** Number of tracked inbound replies (for observability). */
  get trackedReplies(): number {
    return this.inbound.size;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.nym.client.stop();
    this.started = false;
  }

  private assertStarted(): void {
    if (!this.started) throw new Error('NymAddressClient has not been started');
  }
}
