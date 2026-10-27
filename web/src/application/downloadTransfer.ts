/**
 * Resumable range downloader.
 *
 * Downloads are fetched with `Range: bytes=<received>-` (plus `If-Range` when
 * the server supplied an `ETag`) and assembled incrementally. If a transfer
 * fails, the error carries the bytes received so far; the shell keeps them in
 * memory and the next attempt resumes from that offset instead of restarting.
 *
 * Pure with an injected range fetcher, so `node --test web/test` covers resume,
 * restart-on-200, abort, and bounds without the mixnet.
 */
import { isAbortError } from '../lib/abort.ts';
import { headerValue, responseValidators, type HeaderRecord } from './httpHeaders.ts';
import { parseContentLength } from './httpHeaders.ts';
import { parseContentRange, responseTotal } from './ranges.ts';

export interface RangeResponse {
  status: number;
  headers: HeaderRecord;
  body: Uint8Array;
}

export interface RangeRequest {
  start: number;
  /** Inclusive end; null means "to the end of the resource". */
  end: number | null;
  etag: string | null;
}

export type RangeFetcher = (request: RangeRequest, signal?: AbortSignal) => Promise<RangeResponse>;

export interface TransferOptions {
  /** Bytes already received by an earlier attempt. */
  initial?: Uint8Array;
  total?: number | null;
  etag?: string | null;
  maxBytes?: number;
  maxChunks?: number;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number | null) => void;
}

export interface TransferResult {
  bytes: Uint8Array;
  received: number;
  total: number | null;
  etag: string | null;
  resumed: boolean;
}

export const DEFAULT_MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_DOWNLOAD_CHUNKS = 512;

export class TransferError extends Error {
  bytes: Uint8Array;
  received: number;
  total: number | null;
  etag: string | null;

  constructor(message: string, state: { bytes: Uint8Array; total: number | null; etag: string | null }) {
    super(message);
    this.name = 'TransferError';
    this.bytes = state.bytes;
    this.received = state.bytes.length;
    this.total = state.total;
    this.etag = state.etag;
  }
}

export async function transferRanges(fetcher: RangeFetcher, options: TransferOptions = {}): Promise<TransferResult> {
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES);
  const maxChunks = Math.max(1, options.maxChunks ?? DEFAULT_MAX_DOWNLOAD_CHUNKS);
  const signal = options.signal;
  const initial = options.initial ?? new Uint8Array(0);
  const chunks: Uint8Array[] = initial.length > 0 ? [copyBytes(initial)] : [];
  let received = initial.length;
  let total = options.total ?? null;
  let etag = options.etag ?? null;
  let resumes = initial.length > 0;
  let hops = 0;

  const fail = (message: string): never => {
    const error = new TransferError(message, { bytes: merge(chunks), total, etag });
    if (signal?.aborted) error.name = 'AbortError';
    throw error;
  };

  if (total !== null && received >= total) {
    return { bytes: merge(chunks).slice(0, total), received: total, total, etag, resumed: resumes };
  }

  for (;;) {
    if (signal?.aborted) fail('download cancelled');
    if (hops >= maxChunks) fail('download chunk limit reached');
    hops += 1;

    let response: RangeResponse;
    try {
      response = await fetcher({ start: received, end: null, etag: received > 0 ? etag : null }, signal);
    } catch (error) {
      if (isAbortError(error)) fail('download cancelled');
      fail(error instanceof Error ? error.message : String(error));
      return fail('download failed');
    }

    const headers = response.headers ?? {};
    const range = parseContentRange(headerValue(headers, 'content-range'));
    const advertised = responseTotal(headers) ?? range?.total ?? null;
    const contentLength = parseContentLength(headerValue(headers, 'content-length'));
    const nextEtag = responseValidators(headers).etag;
    if (nextEtag) etag = nextEtag;

    if (response.status === 416) {
      if (total !== null && received >= total) break;
      fail('server rejected the resume offset');
    }

    if (response.status === 200) {
      // The server ignored Range. If we had resumed, the body is the complete
      // resource, so replace the prefix rather than appending a duplicate.
      if (received > 0) {
        chunks.length = 0;
        received = 0;
        resumes = false;
      }
      total = advertised ?? contentLength ?? null;
      if (advertised === null && contentLength !== null) total = contentLength;
      append(chunks, response.body);
      received += response.body.length;
      if (total === null) total = received;
    } else if (response.status === 206) {
      if (range) {
        if (range.start !== received) fail(`range gap: expected byte ${received}, got ${range.start}`);
        total = range.total ?? advertised ?? total;
      } else {
        total = advertised ?? total;
      }
      append(chunks, response.body);
      received += response.body.length;
    } else if (response.status >= 200 && response.status < 300) {
      // A non-standard 2xx is still a usable body; treat it like 200.
      if (received > 0) {
        chunks.length = 0;
        received = 0;
        resumes = false;
      }
      total = advertised ?? contentLength ?? total;
      append(chunks, response.body);
      received += response.body.length;
      if (total === null) total = received;
    } else {
      fail(`download failed (HTTP ${response.status})`);
    }

    if (received > maxBytes) fail(`download is too large (${received} bytes; limit ${maxBytes})`);
    options.onProgress?.(received, total);

    if (total !== null && received >= total) break;
    if (response.body.length === 0) {
      if (total !== null && received < total) fail(`empty chunk at byte ${received}`);
      break;
    }
    if (response.status === 200) break;
  }

  const bytes = merge(chunks);
  if (total !== null && bytes.length > total)
    return { bytes: bytes.slice(0, total), received: total, total, etag, resumed: resumes };
  return { bytes, received: bytes.length, total, etag, resumed: resumes };
}

function append(chunks: Uint8Array[], bytes: Uint8Array): void {
  if (!bytes || bytes.length === 0) return;
  chunks.push(copyBytes(bytes));
}

function copyBytes(bytes: Uint8Array): Uint8Array {
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
