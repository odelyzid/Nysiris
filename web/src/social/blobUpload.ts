/**
 * Attachment upload protocol: chunk sizing, per-part preimages, and request
 * bodies for the blob-part endpoint. Pure (no browser globals, no mixnet) —
 * the tunnel driver lives in `./blobUploadIo.ts`.
 */
import { b64encode, hexToBytes } from '../lib/bytes.ts';

/** Upload chunk size: request envelopes are capped at 64 KiB, so blobs
 * travel as one envelope per chunk. Mirrors `attach::MAX_BLOB_PART_BYTES`. */
export const BLOB_PART_BYTES = 45_056;
export const BLOB_MAX_PARTS = 8;

export interface BlobPart {
  path: string;
  body: Uint8Array;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function isImageMime(mime: string): boolean {
  return mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp' || mime === 'image/gif';
}

/** How many upload parts a blob of `blobLength` bytes needs. */
export function blobPartCount(blobLength: number): number {
  return Math.ceil(blobLength / BLOB_PART_BYTES);
}

/**
 * The bytes a part's PoW binds to: `id(32) || part_be32 || chunk`. Mirror of
 * the provider's preimage construction.
 */
export function blobPartPreimage(id: string, part: number, chunk: Uint8Array): Uint8Array {
  const idBytes = hexToBytes(id);
  const preimage = new Uint8Array(idBytes.length + 4 + chunk.length);
  preimage.set(idBytes, 0);
  new DataView(preimage.buffer).setUint32(idBytes.length, part);
  preimage.set(chunk, idBytes.length + 4);
  return preimage;
}

/** The `POST /blob/part` request (path + JSON body) for one chunk. */
export function blobPartBody(id: string, part: number, of: number, chunk: Uint8Array, pow?: unknown): BlobPart {
  return {
    path: `/blob/part?id=${id}&part=${part}&of=${of}`,
    body: new TextEncoder().encode(JSON.stringify({ bytes_b64: b64encode(chunk), ...(pow ? { pow } : {}) })),
  };
}
