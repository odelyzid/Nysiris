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