/**
 * Dependency-free byte helpers shared across `mixnet/` and `social/`.
 * Pure TS (no noble, no browser globals beyond `btoa`/`atob`), so Node
 * type-stripping tests cover it directly.
 */

/** Base64-encode bytes via `btoa`, chunked to dodge call-stack limits, with a Node `Buffer` fallback. */
export function b64encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  // eslint-disable-next-line no-undef
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
}

/** Base64-decode to bytes via `atob`, with a Node `Buffer` fallback. */
export function b64decode(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  // eslint-disable-next-line no-undef
  const binary = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** 8-byte big-endian encoding of a non-negative integer (u64 wire form). */
export function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

const HEX_RE = /^[0-9a-f]+$/i;

/**
 * Strict hex decode (lowercase canonical). Returns a *copy*. Throws on odd
 * length or non-hex input rather than guessing — callers must validate first.
 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = String(hex).trim().toLowerCase();
  if (clean.length % 2 !== 0 || !HEX_RE.test(clean)) {
    throw new Error('invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Lowercase hex encode of raw bytes (the canonical wire case). */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}