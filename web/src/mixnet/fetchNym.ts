/**
 * `fetchNym()` — fetch from a Nym hidden service the way `fetch` works for the
 * clearnet: one call, one response.
 *
 * ```ts
 * const res = await fetchNym(recipient, { method: 'GET', path: '/' });
 * res.status;            // 200
 * res.headers;           // { 'content-type': 'text/html' }
 * new TextDecoder().decode(res.body);  // Uint8Array -> text
 * ```
 *
 * How it works: the request is sent as a hidden-service envelope over the
 * pure-mixnet messaging path (`rawSend`), and the first valid response
 * envelope that arrives afterwards is the reply (the bridge answers each
 * request with exactly one SURB reply).
 *
 * Requests share one persistent `NymAddressClient`. Plain `fetchNym` calls
 * are **serialized by a mutex**: the browser SDK (1.4.1) has no sender tags,
 * so correlation by anything stronger is unavailable, and booting a fresh
 * WASM client + gateway handshake per request (as earlier revisions did)
 * piles up overlapping clients on every poll until replies time out. The
 * client is kept across calls and only rebooted after a boot failure or an
 * explicit `stopFetchNymClient()`. `fetchNymParallel` lifts the mutex for
 * callers whose provider echoes correlation tags (see `Request::tag`).
 *
 * Security: the envelope is validated before sending (`hiddenService.mjs`),
 * bodies are capped at 64 KiB, and the wait has a deadline.
 */
import { NymAddressClient } from './messaging';
import { decodeResponse, dispatchReply, encodeRequest } from './hiddenService.mjs';
import { b64decode, b64encode } from '../lib/bytes';

const NYM_API_URL = 'https://validator.nymtech.net/api';

export interface FetchNymRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  /** Raw body bytes; encoded to base64 inside the envelope. */
  body?: Uint8Array;
}

export interface FetchNymResponse {
  status: number;
  headers: Record<string, string>;
  /** Raw body bytes (base64-decoded from the envelope). */
  body: Uint8Array;
  error: string | null;
}

export interface FetchNymOptions {
  nymApiUrl?: string;
  /** How long to wait for the SURB reply. Default 90 s (mixnet latency). */
  timeoutMs?: number;
}

/** @deprecated use `b64encode` from `../lib/bytes`; kept for existing callers. */
export const toBase64 = b64encode;
/** @deprecated use `b64decode` from `../lib/bytes`; kept for existing callers. */
export const fromBase64 = b64decode;

/** Persistent client shared by all `fetchNym` calls (boot promise). */
let sharedClient: Promise<NymAddressClient> | null = null;
let sharedApiUrl = '';

/**
 * Resolver for the request currently awaiting its SURB reply. At most one
 * exists at any time: calls are serialized by `mutex` below, so the first
 * valid envelope is always the current request's reply.
 */
let currentWaiter: ((text: string) => void) | null = null;

/** Waiters for in-flight parallel requests, keyed by correlation tag. */
const parallelWaiters = new Map<string, (text: string) => void>();

/** Recipients whose provider never echoed a tag (pre-tag deployments). */
const parallelBroken = new Set<string>();

let tagCounter = 0;

/** Unique correlation nonce for one parallel request. */
function nextTag(): string {
  tagCounter += 1;
  return `p${Date.now().toString(36)}-${tagCounter}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

/** Start the shared client once; a failed boot is forgotten so the next call retries. */
function ensureClient(nymApiUrl: string): Promise<NymAddressClient> {
  if (!sharedClient || sharedApiUrl !== nymApiUrl) {
    sharedApiUrl = nymApiUrl;
    const boot = (async () => {
      const client = new NymAddressClient();
      await client.start(
        nymApiUrl,
        (msg) => {
          // Anything else (echoes of our own cover, unrelated chatter) is ignored.
          dispatchReply(msg.text, parallelWaiters, currentWaiter);
        },
        () => {},
      );
      return client;
    })();
    sharedClient = boot;
    boot.catch(() => {
      if (sharedClient === boot) sharedClient = null;
    });
  }
  return sharedClient;
}

/** Serializes requests: the SDK cannot correlate concurrent calls. */
let mutex: Promise<void> = Promise.resolve();

export async function fetchNym(
  recipient: string,
  request: FetchNymRequest,
  options?: FetchNymOptions,
): Promise<FetchNymResponse> {
  const task = mutex.then(() => runOnce(recipient, request, options));
  // The chain must survive individual failures so later calls still run.
  mutex = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function runOnce(
  recipient: string,
  request: FetchNymRequest,
  options?: FetchNymOptions,
): Promise<FetchNymResponse> {
  const envelope = encodeRequest({
    method: request.method ?? 'GET',
    path: request.path,
    headers: request.headers ?? {},
    bodyBase64: request.body ? toBase64(request.body) : '',
  });

  const timeoutMs = options?.timeoutMs ?? 90_000;
  const client = await ensureClient(options?.nymApiUrl ?? NYM_API_URL);

  const reply = await new Promise<string>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      currentWaiter = null;
      reject(new Error(`fetchNym timed out after ${timeoutMs} ms waiting for the SURB reply`));
    }, timeoutMs);
    currentWaiter = (text: string) => {
      window.clearTimeout(timer);
      currentWaiter = null;
      resolve(text);
    };
    client.send(recipient, envelope).catch((err: unknown) => {
      window.clearTimeout(timer);
      currentWaiter = null;
      reject(err);
    });
  });

  const parsed = decodeResponse(reply);
  return {
    status: parsed.status,
    headers: parsed.headers,
    body: fromBase64(parsed.bodyBase64),
    error: parsed.error,
  };
}

/**
 * Parallel requests over the shared client, matched by echoed correlation
 * tags (see `Request::tag`). The provider must echo tags — current
 * `nysiris-social` does (via `dispatch`); a provider that never echoes
 * lands the recipient in `parallelBroken` and later calls transparently
 * fall back to the serialized path.
 *
 * Order of `results` matches order of `requests`.
 */
export async function fetchNymParallel(
  recipient: string,
  requests: FetchNymRequest[],
  options?: FetchNymOptions & { concurrency?: number },
): Promise<FetchNymResponse[]> {
  if (requests.length < 2 || parallelBroken.has(recipient)) {
    const out: FetchNymResponse[] = [];
    for (const r of requests) out.push(await fetchNym(recipient, r, options));
    return out;
  }
  const client = await ensureClient(options?.nymApiUrl ?? NYM_API_URL);
  const timeoutMs = options?.timeoutMs ?? 90_000;
  const limit = Math.min(Math.max(options?.concurrency ?? 3, 1), 8);
  const results = new Array<FetchNymResponse>(requests.length);
  let next = 0;
  let failed: unknown = null;
  async function worker(): Promise<void> {
    for (;;) {
      if (failed !== null) return;
      const i = next;
      next += 1;
      if (i >= requests.length) return;
      try {
        results[i] = await runTagged(client, recipient, requests[i], timeoutMs);
      } catch (err) {
        failed = err;
        return;
      }
    }
  }
  const workers = Math.min(limit, requests.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (failed !== null) {
    parallelBroken.add(recipient);
    throw failed;
  }
  return results;
}

/** One tagged request: waiter registered before send, always cleaned up. */
function runTagged(
  client: NymAddressClient,
  recipient: string,
  request: FetchNymRequest,
  timeoutMs: number,
): Promise<FetchNymResponse> {
  const tag = nextTag();
  const envelope = encodeRequest({
    method: request.method ?? 'GET',
    path: request.path,
    headers: request.headers ?? {},
    bodyBase64: request.body ? toBase64(request.body) : '',
    tag,
  });
  return new Promise<FetchNymResponse>((resolve, reject) => {
    const done = () => parallelWaiters.delete(tag);
    const timer = window.setTimeout(() => {
      done();
      reject(new Error(`fetchNym timed out after ${timeoutMs} ms waiting for the SURB reply`));
    }, timeoutMs);
    parallelWaiters.set(tag, (text: string) => {
      window.clearTimeout(timer);
      done();
      try {
        const parsed = decodeResponse(text);
        resolve({
          status: parsed.status,
          headers: parsed.headers,
          body: fromBase64(parsed.bodyBase64),
          error: parsed.error,
        });
      } catch (err) {
        reject(err);
      }
    });
    client.send(recipient, envelope).catch((err: unknown) => {
      window.clearTimeout(timer);
      done();
      reject(err);
    });
  });
}

/**
 * Shut down the shared client (e.g. on app unmount). The next `fetchNym`
 * call boots a fresh one. An in-flight request is left to time out.
 */
export async function stopFetchNymClient(): Promise<void> {
  const boot = sharedClient;
  sharedClient = null;
  currentWaiter = null;
  parallelWaiters.clear();
  if (boot) {
    const client = await boot.catch(() => null);
    await client?.stop().catch(() => {});
  }
}
