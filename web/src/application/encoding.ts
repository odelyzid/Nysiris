/**
 * `Content-Encoding` decoding for mixnet-fetched bytes.
 *
 * HTTP responses can arrive gzip/deflate-compressed even though the document
 * is rendered from an in-memory body. The browser's `DecompressionStream` does
 * the work; an injectable decompressor keeps the rules unit-testable and lets
 * unsupported codings (`br` on older engines) fail with a clear message rather
 * than silently showing compressed bytes as text.
 */

export type ContentCoding = 'gzip' | 'deflate' | 'deflate-raw' | 'br' | 'zstd';

export interface DecodeOptions {
  /** Guard against decompression bombs (default 64 MiB per response). */
  maxBytes?: number;
  /** Test seam; defaults to `DecompressionStream`. */
  decompress?: (bytes: Uint8Array, coding: ContentCoding) => Promise<Uint8Array>;
}

export const DEFAULT_MAX_DECODED_BYTES = 64 * 1024 * 1024;

/** Codings in header order, lowercased and without `identity`/blank entries. */
export function contentEncodings(header: unknown): string[] {
  return String(header ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value && value !== 'identity');
}

export async function decodeContentEncoding(
  bytes: Uint8Array,
  header: unknown,
  options: DecodeOptions = {},
): Promise<Uint8Array> {
  const codings = contentEncodings(header);
  if (codings.length === 0 || bytes.length === 0) return bytes;
  const decompress = options.decompress ?? decompressWithStream;
  let out = bytes;
  // Codings are listed in the order they were applied; decode in reverse.
  for (const coding of [...codings].reverse()) {
    const normalised = coding === 'x-gzip' ? 'gzip' : coding;
    if (!isSupportedCoding(normalised)) throw new Error(`unsupported content-encoding: ${coding}`);
    out = await decompress(out, normalised);
    if (out.length > (options.maxBytes ?? DEFAULT_MAX_DECODED_BYTES)) {
      throw new Error('decoded response is too large');
    }
  }
  return out;
}

function isSupportedCoding(value: string): value is ContentCoding {
  return value === 'gzip' || value === 'deflate' || value === 'deflate-raw' || value === 'br' || value === 'zstd';
}

async function decompressWithStream(bytes: Uint8Array, coding: ContentCoding): Promise<Uint8Array> {
  const Stream = globalThis.DecompressionStream as typeof DecompressionStream | undefined;
  if (typeof Stream !== 'function') throw new Error(`content-encoding ${coding} is not supported by this browser`);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new Blob([copy]).stream().pipeThrough(new Stream(coding as CompressionFormat));
  } catch {
    throw new Error(`content-encoding ${coding} is not supported by this browser`);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > DEFAULT_MAX_DECODED_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('decoded response is too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
