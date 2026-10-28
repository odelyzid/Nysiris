/**
 * App-side half of the media range bridge.
 *
 * The service worker receives a media element's `Range` request, forwards
 * `{type:'nysiris:media-range'}` to the controlled window, and this module
 * resolves the token through `mediaSessions`, fetches the bytes through the
 * same mixnet/clearnet range path as downloads, and returns a `206` body.
 */
import { headerValue, type HeaderRecord } from '../../application/httpHeaders';
import { mediaSessions, mediaStreamingAvailable, type MediaSession } from '../../application/mediaSession';
import { parseContentRange } from '../../application/ranges';
import { isAbortError } from '../../lib/abort';

export const MEDIA_RANGE_MESSAGE = 'nysiris:media-range';
export const MEDIA_CHUNK_MESSAGE = 'nysiris:media-chunk';

export interface MediaBridgeOptions {
  /** Fetch one range through the active transport. */
  fetchRange: (
    url: string,
    request: { start: number; end: number | null; etag: string | null },
    signal?: AbortSignal,
  ) => Promise<{ status: number; headers: HeaderRecord; body: Uint8Array }>;
  sessions?: typeof mediaSessions;
  /** Safety cap for one media request; the next request continues from here. */
  maxChunkBytes?: number;
}

const DEFAULT_MAX_CHUNK_BYTES = 8 * 1024 * 1024;

/** Start listening for service-worker range requests; returns cleanup. */
export function startMediaBridge(options: MediaBridgeOptions): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
  const sessions = options.sessions ?? mediaSessions;
  const maxBytes = Math.max(1, options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES);
  const onMessage = (event: MessageEvent) => {
    const data = event.data as {
      type?: unknown;
      requestId?: unknown;
      token?: unknown;
      start?: unknown;
      end?: unknown;
    } | null;
    if (!data || data.type !== MEDIA_RANGE_MESSAGE || typeof data.requestId !== 'string') return;
    void respond(data.requestId, String(data.token ?? ''), toOffset(data.start), toOffset(data.end));
  };

  async function respond(requestId: string, token: string, start: number, end: number | null) {
    const session = sessions.get(token);
    // Another window may own this token; stay silent so it can answer.
    if (!session) return;
    try {
      const result = await fetchWindow(options, session, start, end, maxBytes);
      postChunk(requestId, result.status, result.headers, result.body);
    } catch (err) {
      if (isAbortError(err)) {
        postChunk(requestId, 499, { 'content-type': 'text/plain' }, encode('media request aborted'));
      } else {
        postChunk(
          requestId,
          502,
          { 'content-type': 'text/plain' },
          encode(err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}

async function fetchWindow(
  options: MediaBridgeOptions,
  session: MediaSession,
  start: number,
  end: number | null,
  maxBytes: number,
): Promise<{ status: number; headers: HeaderRecord; body: Uint8Array }> {
  const chunks: Uint8Array[] = [];
  let offset = start;
  let total = session.total;
  let contentType = session.contentType;
  let etag = session.etag;
  let status = 200;
  let hops = 0;

  while (hops < 32) {
    hops += 1;
    const response = await options.fetchRange(
      session.url,
      { start: offset, end, etag: offset > 0 ? etag : session.etag },
      undefined,
    );
    const headers = response.headers ?? {};
    contentType = headerValue(headers, 'content-type') || contentType;
    etag = headerValue(headers, 'etag') || etag;
    if (response.status === 200) {
      // Server ignored Range. Hand the whole representation back to the
      // browser; the media element can still play it, and the next request may
      // be served from its own cache.
      return { status: 200, headers, body: response.body };
    }
    if (response.status !== 206) {
      return { status: response.status, headers, body: response.body };
    }
    const range = parseContentRange(headerValue(headers, 'content-range'));
    if (range?.total != null) total = range.total;
    if (range && range.start !== offset && chunks.length === 0) {
      return {
        status: 416,
        headers: { 'content-range': `bytes */${total ?? '*'}` },
        body: new Uint8Array(0),
      };
    }
    if (response.body.length === 0) break;
    chunks.push(copy(response.body));
    offset += response.body.length;
    status = 206;
    if (offset - start >= maxBytes) break;
    if (end !== null && offset > end) break;
    if (end === null) break;
  }

  const body = merge(chunks);
  const actualEnd = start + body.length - 1;
  return {
    status: status === 206 ? 206 : 200,
    headers: {
      'content-type': contentType || 'application/octet-stream',
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      ...(status === 206 ? { 'content-range': `bytes ${start}-${actualEnd}/${total ?? '*'}` } : {}),
      ...(etag ? { etag } : {}),
    },
    body,
  };
}

function postChunk(requestId: string, status: number, headers: HeaderRecord, body: Uint8Array): void {
  const transferable = copy(body);
  try {
    navigator.serviceWorker.controller?.postMessage(
      {
        type: MEDIA_CHUNK_MESSAGE,
        requestId,
        status,
        headers,
        body: transferable.buffer,
      },
      [transferable.buffer],
    );
  } catch {
    // Worker was replaced/closed; the pending SW request times out.
  }
}

function toOffset(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function copy(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

function merge(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export { mediaStreamingAvailable };
