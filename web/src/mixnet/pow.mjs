/**
 * Client-side proof-of-work. Byte-exact mirror of
 * `crates/portal-reputation/src/pow.rs`:
 *
 *   pow_bytes = domain || author(32) || payload_hash(32) || nonce_be64
 *   valid     = SHA256(pow_bytes) has `bits` leading zero bits
 *
 * Uses WebCrypto (`crypto.subtle`), available in browsers (secure contexts)
 * and Node 20+. No dependencies, so `node --test web/test` covers it.
 */

export const POW_DOMAIN = 'fly-portal-v1/pow';
export const MAX_POW_BITS = 32;

const enc = new TextEncoder();

async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** SHA-256 of raw bytes: the payload commitment proofs bind to. */
export async function payloadHashBytes(data) {
  return sha256(data);
}

async function hashProof(authorBytes, payloadHash, nonce) {
  const preimage = new Uint8Array(POW_DOMAIN.length + 32 + 32 + 8);
  preimage.set(enc.encode(POW_DOMAIN), 0);
  preimage.set(authorBytes, POW_DOMAIN.length);
  preimage.set(payloadHash, POW_DOMAIN.length + 32);
  new DataView(preimage.buffer).setBigUint64(POW_DOMAIN.length + 64, BigInt(nonce));
  return sha256(preimage);
}

/** Count leading zero bits of a hash. */
export function leadingZeros(hash) {
  let zeros = 0;
  for (const byte of hash) {
    if (byte === 0) {
      zeros += 8;
    } else {
      zeros += Math.clz32(byte) - 24;
      break;
    }
  }
  return zeros;
}

/**
 * Verify a proof. Cheap: exactly one hash. Never throws on malformed input.
 * @param {Uint8Array} authorBytes 32-byte author key
 * @param {Uint8Array} payloadHash 32-byte payload commitment
 * @param {{ nonce: number, bits: number }} proof
 * @returns {Promise<boolean>}
 */
export async function verifyPow(authorBytes, payloadHash, proof) {
  try {
    if (!proof || authorBytes?.length !== 32 || payloadHash?.length !== 32) return false;
    const bits = Number(proof.bits);
    const nonce = Number(proof.nonce);
    if (!Number.isInteger(bits) || !Number.isInteger(nonce) || bits <= 0 || bits > MAX_POW_BITS || nonce < 0) {
      return false;
    }
    return leadingZeros(await hashProof(authorBytes, payloadHash, nonce)) >= bits;
  } catch {
    return false;
  }
}

/**
 * Search nonces for a proof. Resolves to null on exhaustion or absurd input.
 * Yields to the event loop every 4096 hashes so the UI stays alive.
 */
export async function provePow(authorBytes, payloadHash, bits, options = {}) {
  const { start = Math.floor(Math.random() * 2 ** 32), maxAttempts = 5_000_000 } = options;
  if (authorBytes?.length !== 32 || payloadHash?.length !== 32) return null;
  if (!Number.isInteger(bits) || bits <= 0 || bits > MAX_POW_BITS) return null;
  if (!(maxAttempts > 0)) return null;
  const end = Math.min(start + maxAttempts, Number.MAX_SAFE_INTEGER);
  for (let nonce = Math.max(0, Math.floor(start)); nonce < end; nonce += 1) {
    if (leadingZeros(await hashProof(authorBytes, payloadHash, nonce)) >= bits) {
      return { nonce, bits };
    }
    if ((nonce & 4095) === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return null;
}
