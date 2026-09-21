/**
 * Clearnet fetch over the mixnet, via an Exit Gateway's IP Packet Router.
 *
 * TLS terminates end-to-end between this WASM client and the destination, so
 * the exit sees the destination but only ciphertext for HTTPS. The destination
 * sees the exit gateway's IP, never the user's.
 *
 * Security: a fixed exit is a linking key at the destination (§5.2.2), so this
 * module tracks requests against an exit-rotation policy and exposes when a
 * reconnect (which is the only way to change the exit in a one-shot tunnel)
 * is recommended.
 */
import { ensureTunnel } from './tunnel';
import { ExitPolicy, ExitRotation } from './enforcement.mjs';

/** Bounded reuse (50 requests, ±10 jitter) balances P2 linkability against reconnect cost. */
const exitPolicy = new ExitPolicy({ policy: ExitRotation.Every, maxRequests: 50, jitter: 10 });

export async function mixnetFetch(input: string, init?: RequestInit): Promise<Response> {
  await ensureTunnel();
  const { mixFetch } = await import('@nymproject/mix-fetch');
  const response = (await mixFetch(input, init as never)) as Response;
  exitPolicy.recordRequest();
  if (exitPolicy.shouldRecommendReconnect()) {
    console.warn(
      `nym exit policy: ${exitPolicy.count} requests on one exit; ` +
        ExitPolicy.reconnectNote,
    );
  }
  return response;
}

/** Current exit-rotation state, for the UI. */
export function exitStatus(): { requests: number; recommendReconnect: boolean } {
  return {
    requests: exitPolicy.count,
    recommendReconnect: exitPolicy.shouldRecommendReconnect(),
  };
}

/**
 * Compare the source IP a service sees over clearnet vs over the mixnet.
 * A mismatch is the simplest positive proof that the tunnel carried the request.
 */
export async function proveTunnel(
  url: string,
): Promise<{ clearnet: string; mixnet: string; differ: boolean }> {
  const clearnetBody = (await (await fetch(url)).json()) as { ip?: string };
  const mixnetBody = (await (await mixnetFetch(url)).json()) as { ip?: string };
  const clearnet = String(clearnetBody.ip ?? '');
  const mixnet = String(mixnetBody.ip ?? '');
  return { clearnet, mixnet, differ: clearnet !== mixnet };
}
