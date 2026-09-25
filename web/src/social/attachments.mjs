/**
 * Attachment validation + canonical encoding. Byte-exact mirror of
 * `services/social/src/attach.rs`.
 *
 * Dependency-free so `node --test web/test` and the offline
 * `./build.sh check` loop cover it; noble crypto lives in
 * `./attachmentCrypto.ts`.
 *
 * @typedef {object} AttachmentRef
 * @property {string} id content address: SHA256(ciphertext blob), lowercase hex
 * @property {string} name sanitized original filename
 * @property {string} mime whitelisted MIME type
 * @property {number} size plaintext size in bytes
 * @property {string} key file key, 32 bytes hex (cleartext in posts, sealed in DMs)
 */

import { hexToBytes } from '../lib/bytes.ts';

export const MAX_ATTACHMENT_BYTES = 262_144;
export const MAX_ATTACHMENTS_PER_MESSAGE = 3;
export const MAX_FILENAME_CHARS = 80;
/** XChaCha nonce (24) + Poly1305 tag (16): ciphertext overhead per blob. */
export const ATTACHMENT_OVERHEAD_BYTES = 40;

/** @type {readonly ['image/jpeg','image/png','image/webp','image/gif','text/plain','text/markdown','application/pdf']} */
export const ALLOWED_MIMES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'text/plain',
  'text/markdown',
  'application/pdf',
]);

/**
 * @param {string} mime
 * @returns {boolean}
 */
export function mimeAllowed(mime) {
  return ALLOWED_MIMES.includes(mime);
}

/**
 * Strip a filename down to something safe to store and display: drop any
 * directory parts, control characters, and path separators; fall back to
 * `file` when nothing survives. Truncates to 80 chars and 255 UTF-8 bytes
 * (the canonical signature encoding uses a single length byte).
 *
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeFilename(raw) {
  const parts = String(raw).split(/[\\/]/);
  const base = parts[parts.length - 1] ?? '';
  // eslint-disable-next-line no-control-regex
  let clean = base.replace(/[\0-\x1f\x7f]/g, '').trim();
  if (!clean || clean === '.' || clean === '..') clean = 'file';
  if ([...clean].length > MAX_FILENAME_CHARS) {
    clean = [...clean].slice(0, MAX_FILENAME_CHARS).join('');
  }
  const bytes = new TextEncoder().encode(clean);
  if (bytes.length > 255) {
    let end = 255;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
    clean = new TextDecoder().decode(bytes.slice(0, end));
  }
  return clean;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Validate one attachment ref from an incoming envelope. Fail-closed: any
 * defect throws and the message is dropped, never rendered partially.
 *
 * @param {unknown} value
 * @returns {AttachmentRef}
 */
export function parseAttachmentRef(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('attachment must be an object');
  }
  const r = /** @type {Record<string, unknown>} */ (value);
  if (typeof r.id !== 'string' || !HEX64.test(r.id.trim().toLowerCase())) {
    throw new Error('attachment id must be 32 bytes hex');
  }
  if (typeof r.key !== 'string' || !HEX64.test(r.key.trim().toLowerCase())) {
    throw new Error('attachment key must be 32 bytes hex');
  }
  if (typeof r.mime !== 'string' || !mimeAllowed(r.mime)) {
    throw new Error('attachment MIME not allowed');
  }
  if (typeof r.name !== 'string') throw new Error('attachment name must be a string');
  const name = sanitizeFilename(r.name);
  if (typeof r.size !== 'number' || !Number.isInteger(r.size) || r.size < 0) {
    throw new Error('attachment size must be a non-negative integer');
  }
  if (r.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment too large (max ${MAX_ATTACHMENT_BYTES} bytes)`);
  }
  return {
    id: r.id.trim().toLowerCase(),
    name,
    mime: r.mime,
    size: r.size,
    key: r.key.trim().toLowerCase(),
  };
}

/**
 * Parse + bound the attachments array of an incoming envelope (absent = none).
 *
 * @param {unknown} value
 * @returns {AttachmentRef[]}
 */
export function parseAttachmentRefs(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('attachments must be an array');
  if (value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
  }
  return value.map(parseAttachmentRef);
}

/**
 * Canonical bytes of an attachment list for signature binding. Empty when
 * there are none, so attachment-free messages sign byte-identically to the
 * pre-attachment layout. Mirror of `attach::canonical_attachments`.
 *
 * @param {AttachmentRef[]} atts
 * @returns {Uint8Array}
 */
export function canonicalAttachmentBytes(atts) {
  const enc = new TextEncoder();
  const parts = [];
  for (const a of atts) {
    const mime = enc.encode(a.mime);
    const name = enc.encode(a.name);
    const size = new Uint8Array(8);
    new DataView(size.buffer).setBigUint64(0, BigInt(a.size));
    parts.push(
      hexToBytes(a.id),
      new Uint8Array([mime.length]),
      mime,
      new Uint8Array([name.length]),
      name,
      size,
      hexToBytes(a.key),
    );
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Validate a user-selected file *before* encryption/upload. Returns the
 * sanitized filename, or throws with a UI-ready message.
 *
 * @param {string} name
 * @param {string} mime
 * @param {number} byteLength
 * @returns {string}
 */
export function validateFile(name, mime, byteLength) {
  if (!mimeAllowed(mime)) throw new Error('File type not allowed');
  if (byteLength > MAX_ATTACHMENT_BYTES - ATTACHMENT_OVERHEAD_BYTES) {
    throw new Error(`File too large (max ${MAX_ATTACHMENT_BYTES} bytes)`);
  }
  return sanitizeFilename(name);
}
