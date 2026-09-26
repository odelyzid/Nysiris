/**
 * End-to-end encrypted DMs over the provider's opaque dead-drop.
 *
 * Construction (byte-exact, both directions identical):
 *
 * ```text
 * sender:   eph = random x25519 keypair; epub = X(eph)
 *           shared = X(eph, montgomery(recipient_ed_pub))
 * receiver: shared = X(montgomery(own_ed_priv), epub)
 * key   = BLAKE2b-256("fly-social-v1/dm" || shared)
 * ct    = XChaCha20-Poly1305(key, nonce).encrypt(plaintext)
 * ```
 *
 * Sender-side forward secrecy: the ephemeral key protects the *sender*, and
 * the envelope carries no sender identity at all. Caveat — the recipient
 * decrypts with their long-term identity key, so a future compromise of that
 * key recovers the recipient's entire DM history (there is no ratchet); treat
 * this as email-shape confidentiality, not Signal-shape. The provider stores
 * `{to, epub, nonce, ciphertext}` and learns nothing about the plaintext.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { canonicalAttachmentBytes, parseAttachmentRefs } from '../domain/attachments.mjs';
import { b64decode, b64encode, u64be } from '../lib/bytes.ts';
import type { AttachmentRef } from '../domain/attachmentCrypto';

const DM_DOMAIN = new TextEncoder().encode('fly-social-v1/dm');

/**
 * Signed inner envelope: `fly-social-v1/dm-inner || from(32) || ts_be64 ||
 * msgId(16) || body || attachments`. The outer sealed box keeps the sender
 * anonymous to the provider; this inner signature lets the *recipient*
 * attribute the message, which is what a 1:1 conversation list needs. The
 * provider never sees it — attachment keys included.
 *
 * Version 2 adds the optional `atts` array (canonical bytes above). Version
 * 1 messages (no attachments) verify byte-identically under both.
 */
const DM_INNER_DOMAIN = new TextEncoder().encode('fly-social-v1/dm-inner');
const DM_INNER_VERSION = 2;

/** Mirror of the provider's MAX_DM_BYTES (services/social/src/store.rs). */
/**
 * Max DM ciphertext bytes enforced client-side before proving PoW
 * (`social_format::limits::MAX_DM_BYTES`).
 */
export { MAX_DM_CIPHERTEXT_BYTES } from '../domain/limits.ts';

function kdf(shared: Uint8Array): Uint8Array {
  const input = new Uint8Array(DM_DOMAIN.length + shared.length);
  input.set(DM_DOMAIN, 0);
  input.set(shared, DM_DOMAIN.length);
  return blake2b(input, { dkLen: 32 });
}

export interface SealedDm {
  epubHex: string;
  nonceHex: string;
  ciphertextB64: string;
}

export function sealDm(recipientEdPubHex: string, plaintext: Uint8Array): SealedDm {
  const recipientMont = ed25519.utils.toMontgomery(hexToBytes(recipientEdPubHex));
  const eph = x25519.utils.randomSecretKey();
  const epub = x25519.getPublicKey(eph);
  const shared = x25519.getSharedSecret(eph, recipientMont);
  const key = kdf(shared);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return {
    epubHex: bytesToHex(epub),
    nonceHex: bytesToHex(nonce),
    ciphertextB64: b64encode(ct),
  };
}

/** Throws if the message is not for this key or is corrupted. */
export function openDm(ownEdPrivHex: string, dm: SealedDm): Uint8Array {
  const xpriv = ed25519.utils.toMontgomerySecret(hexToBytes(ownEdPrivHex));
  const shared = x25519.getSharedSecret(xpriv, hexToBytes(dm.epubHex));
  const key = kdf(shared);
  return xchacha20poly1305(key, hexToBytes(dm.nonceHex)).decrypt(b64decode(dm.ciphertextB64));
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function innerSignBytes(
  fromHex: string,
  ts: number,
  msgIdHex: string,
  body: Uint8Array,
  atts: AttachmentRef[] = [],
): Uint8Array {
  const from = hexToBytes(fromHex);
  const msgId = hexToBytes(msgIdHex);
  const time = u64be(ts);
  const attBytes = canonicalAttachmentBytes(atts);
  const out = new Uint8Array(
    DM_INNER_DOMAIN.length + from.length + time.length + msgId.length + body.length + attBytes.length,
  );
  let at = 0;
  out.set(DM_INNER_DOMAIN, at);
  at += DM_INNER_DOMAIN.length;
  out.set(from, at);
  at += from.length;
  out.set(time, at);
  at += time.length;
  out.set(msgId, at);
  at += msgId.length;
  out.set(body, at);
  at += body.length;
  out.set(attBytes, at);
  return out;
}

export interface PackedDm {
  /** JSON envelope, ready to be sealed with `sealDm`. */
  json: string;
  /** Random 16-byte id (hex) — the conversation dedupe key. */
  msgId: string;
}

/**
 * Pack a signed 1:1 message. The sender's identity is proven inside the
 * sealed box only; nothing about the sender leaks to the provider.
 * Attachments ride inside the sealed envelope, so their file keys stay
 * confidential end-to-end.
 */
export function packDmInner(senderPrivHex: string, body: Uint8Array, atts: AttachmentRef[] = []): PackedDm {
  const priv = hexToBytes(senderPrivHex.trim().toLowerCase());
  if (priv.length !== 32) throw new Error('sender private key must be 32 bytes hex');
  const from = bytesToHex(ed25519.getPublicKey(priv));
  const msgId = bytesToHex(randomBytes(16));
  const ts = Date.now();
  const sig = bytesToHex(ed25519.sign(innerSignBytes(from, ts, msgId, body, atts), priv));
  const json = JSON.stringify({
    v: DM_INNER_VERSION,
    from,
    ts,
    msgId,
    bodyB64: b64encode(body),
    ...(atts.length > 0 ? { atts } : {}),
    sig,
  });
  return { json, msgId };
}

export interface OpenedDmInner {
  /** Sender ed25519 pubkey hex (lowercase). */
  from: string;
  /** Sender clock at pack time (ms epoch). Ordering only — never trusted for expiry. */
  ts: number;
  msgId: string;
  body: Uint8Array;
  /** Attachment refs (file keys included — this envelope is sealed). */
  atts: AttachmentRef[];
}

/** Unpack and verify a signed 1:1 message. Throws on any defect. */
export function unpackDmInner(json: string): OpenedDmInner {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error('DM inner envelope is not JSON');
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('DM inner envelope must be an object');
  }
  const { v, from, ts, msgId, bodyB64, atts, sig } = obj as Record<string, unknown>;
  if (v !== DM_INNER_VERSION && v !== 1) throw new Error('unsupported DM inner version');
  if (typeof from !== 'string' || !HEX64.test(from.toLowerCase())) {
    throw new Error('DM inner has a bad sender');
  }
  if (!Number.isInteger(ts) || (ts as number) <= 0) throw new Error('DM inner has a bad timestamp');
  if (typeof msgId !== 'string' || !HEX32.test(msgId.toLowerCase())) {
    throw new Error('DM inner has a bad id');
  }
  if (typeof bodyB64 !== 'string') throw new Error('DM inner has no body');
  if (typeof sig !== 'string' || !HEX128.test(sig)) throw new Error('DM inner has a bad signature');
  let body: Uint8Array;
  try {
    body = b64decode(bodyB64);
  } catch {
    throw new Error('DM inner body is not base64');
  }
  // Attachment refs are validated fail-closed: a malformed ref drops the
  // whole message rather than rendering a partial one.
  let parsedAtts: AttachmentRef[];
  try {
    parsedAtts = parseAttachmentRefs(atts);
  } catch {
    throw new Error('DM inner has bad attachments');
  }
  const normFrom = from.toLowerCase();
  const normId = (msgId as string).toLowerCase();
  let ok = false;
  try {
    ok = ed25519.verify(
      hexToBytes(sig as string),
      innerSignBytes(normFrom, ts as number, normId, body, parsedAtts),
      hexToBytes(normFrom),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new Error('DM inner signature invalid');
  return { from: normFrom, ts: ts as number, msgId: normId, body, atts: parsedAtts };
}
