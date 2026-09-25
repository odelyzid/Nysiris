/**
 * Browser-side attachment encryption. Noble crypto lives here (needs
 * `node_modules`, like the rest of the DM stack); validation and canonical
 * encoding live dependency-free in `./attachments.mjs`.
 *
 * Blob layout: `nonce(24) || ct`, keyed by a random 32-byte file key that is
 * exported into the ref *before* the raw key is wiped. Content address
 * `id = SHA256(blob)` via `payloadHashBytes` — the same hash the provider
 * checks on upload.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { payloadHashBytes } from '../mixnet/pow.mjs';
import {
  ALLOWED_MIMES,
  ATTACHMENT_OVERHEAD_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_FILENAME_CHARS,
} from './attachments.mjs';

// Re-exported so callers need only this module; the single source of truth
// for the values stays in `./attachments.mjs` (typed there via JSDoc).
export { ALLOWED_MIMES };
export type AllowedMime = (typeof ALLOWED_MIMES)[number];
export { ATTACHMENT_OVERHEAD_BYTES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_FILENAME_CHARS };

/** Attachment metadata as carried in a post or (sealed) DM envelope. */
export interface AttachmentRef {
  /** Content address: SHA256(ciphertext blob), lowercase hex. */
  id: string;
  /** Sanitized original filename. */
  name: string;
  /** Whitelisted MIME type. */
  mime: string;
  /** Plaintext size in bytes (UI + pre-download check). */
  size: number;
  /** File key: 32 bytes hex. Cleartext in posts, sealed in DMs. */
  key: string;
}

/** A prepared attachment: metadata plus the ciphertext blob to upload. */
export interface PreparedAttachment extends AttachmentRef {
  blob: Uint8Array;
}

/**
 * Encrypt a validated file: random file key, blob = `nonce || ct`,
 * `id = SHA256(blob)`. Throws when the ciphertext would exceed the cap
 * (paranoia backstop; `validateFile` already bounds the plaintext).
 */
export async function encryptAttachment(
  name: string,
  mime: AllowedMime,
  plain: Uint8Array,
): Promise<PreparedAttachment> {
  if (plain.length > MAX_ATTACHMENT_BYTES - ATTACHMENT_OVERHEAD_BYTES) {
    throw new Error(`File too large (max ${MAX_ATTACHMENT_BYTES} bytes)`);
  }
  const key = randomBytes(32);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(plain);
  const keyHex = bytesToHex(key);
  key.fill(0);
  const blob = new Uint8Array(nonce.length + ct.length);
  blob.set(nonce, 0);
  blob.set(ct, nonce.length);
  if (blob.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`File too large (max ${MAX_ATTACHMENT_BYTES} bytes)`);
  }
  const id = bytesToHex(await payloadHashBytes(blob));
  return { id, name, mime, size: plain.length, key: keyHex, blob };
}

/**
 * Decrypt a downloaded blob with the ref's file key. Verifies the content
 * address first: a blob that doesn't hash to the ref id is rejected before
 * decryption is even attempted. Every failure surfaces as
 * `Attachment unavailable` — callers never distinguish the cause.
 */
export async function decryptAttachment(ref: AttachmentRef, blob: Uint8Array): Promise<Uint8Array> {
  const id = bytesToHex(await payloadHashBytes(blob));
  if (id !== ref.id) throw new Error('Attachment unavailable');
  if (blob.length <= 24) throw new Error('Attachment unavailable');
  const key = hexToBytes(ref.key);
  try {
    return xchacha20poly1305(key, blob.slice(0, 24)).decrypt(blob.slice(24));
  } catch {
    throw new Error('Attachment unavailable');
  } finally {
    key.fill(0);
  }
}

/** Content address of a ciphertext blob (lowercase hex). */
export async function blobId(blob: Uint8Array): Promise<string> {
  return bytesToHex(await payloadHashBytes(blob));
}
