/**
 * Client identity for nysiris: an ed25519 keypair whose public key IS the
 * username. Byte-exact mirror of `services/social/src/sig.rs` — the provider
 * verifies these signatures, so any deviation breaks posting.
 *
 * Keys live in localStorage (`fly.social.identity`). That is app-scoped, not
 * hardware-backed: fine for pseudonyms, not for high-value keys. On Android,
 * prefer a Keystore-backed plugin when available.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { base58Decode, parseNymAddress } from '../mixnet/hiddenService.mjs';

const STORAGE_KEY = 'fly.social.identity';
const POST_DOMAIN = 'fly-social-v1/post';
const PROFILE_DOMAIN = 'fly-social-v1/profile';

interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const memoryKV = (() => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
})();

/** localStorage in browsers, memory fallback in tests/workers. */
function kv(): KV {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // private mode without storage access
  }
  return memoryKV;
}

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

/** UTC day number — coarse time, matching `sig::current_day`. */
export function currentDay(): number {
  return Math.floor(Date.now() / 1000 / 86_400);
}

export interface Identity {
  privHex: string;
  pubHex: string;
}

export function loadIdentity(): Identity | null {
  try {
    const raw = kv().getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { privHex?: unknown; pubHex?: unknown };
    if (typeof parsed.privHex !== 'string' || typeof parsed.pubHex !== 'string') return null;
    if (!/^[0-9a-f]{64}$/i.test(parsed.privHex) || !/^[0-9a-f]{64}$/i.test(parsed.pubHex)) {
      return null;
    }
    return { privHex: parsed.privHex.toLowerCase(), pubHex: parsed.pubHex.toLowerCase() };
  } catch {
    return null;
  }
}

export function createIdentity(): Identity {
  const priv = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(priv);
  const id = { privHex: bytesToHex(priv), pubHex: bytesToHex(pub) };
  kv().setItem(STORAGE_KEY, JSON.stringify(id));
  return id;
}

export function importIdentity(privHex: string): Identity {
  const priv = hexToBytes(privHex.trim().toLowerCase());
  if (priv.length !== 32) throw new Error('private key must be 32 bytes hex');
  const pub = ed25519.getPublicKey(priv);
  const id = { privHex: bytesToHex(priv), pubHex: bytesToHex(pub) };
  kv().setItem(STORAGE_KEY, JSON.stringify(id));
  return id;
}

/** A reply parent: 16 raw bytes as 32 hex chars (a post `id`). Null/empty = top-level. */
export function parseParentHex(inReplyTo?: string | null): Uint8Array | null {
  if (!inReplyTo) return null;
  const clean = inReplyTo.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(clean)) throw new Error('in_reply_to must be a 16-byte post id in hex');
  return hexToBytes(clean);
}

/**
 * Sign a post: `domain || author(32) || day_be64 || parent(16) || body`.
 * Byte-exact mirror of `sig::post_message` — `parent` is zeros when absent.
 */
export function signPost(
  privHex: string,
  authorHex: string,
  day: number,
  body: Uint8Array,
  inReplyTo?: string | null,
): string {
  const msg = concat(
    enc.encode(POST_DOMAIN),
    hexToBytes(authorHex),
    u64be(day),
    parseParentHex(inReplyTo) ?? new Uint8Array(16),
    body,
  );
  return bytesToHex(ed25519.sign(msg, hexToBytes(privHex)));
}

/**
 * Verify a received post before rendering. Mirror of `sig::post_message`.
 * Falls back to the legacy layout (no parent field) for rows written before
 * threaded replies existed, so old timelines keep rendering.
 */
export function verifyPostSignature(
  authorHex: string,
  day: number,
  body: Uint8Array,
  sigHex: string,
  inReplyTo?: string | null,
): boolean {
  try {
    const msg = concat(
      enc.encode(POST_DOMAIN),
      hexToBytes(authorHex),
      u64be(day),
      parseParentHex(inReplyTo) ?? new Uint8Array(16),
      body,
    );
    if (ed25519.verify(hexToBytes(sigHex), msg, hexToBytes(authorHex))) return true;
    if (inReplyTo) return false;
    const legacy = concat(enc.encode(POST_DOMAIN), hexToBytes(authorHex), u64be(day), body);
    return ed25519.verify(hexToBytes(sigHex), legacy, hexToBytes(authorHex));
  } catch {
    return false;
  }
}

/**
 * PoW preimage for a post: parent bytes (if any) + body. Mirrors the
 * provider, which binds the same preimage so a top-level proof can't be
 * replayed onto a reply.
 */
export function postPowPayload(body: Uint8Array, inReplyTo?: string | null): Uint8Array {
  const parent = parseParentHex(inReplyTo);
  if (!parent) return body;
  const out = new Uint8Array(parent.length + body.length);
  out.set(parent, 0);
  out.set(body, parent.length);
  return out;
}
/** Sign a profile: `domain || author(32) || name || 0x00 || bio`. */
export function signProfile(privHex: string, authorHex: string, name: string, bio: string): string {
  const msg = concat(
    enc.encode(PROFILE_DOMAIN),
    hexToBytes(authorHex),
    enc.encode(name),
    new Uint8Array([0]),
    enc.encode(bio),
  );
  return bytesToHex(ed25519.sign(msg, hexToBytes(privHex)));
}

const INVITE_DOMAIN = 'fly-portal-v1/invite';

/**
 * Max vouched IDs per invite. Links grow ~86 chars per vouch (base64url of
 * 64 hex chars), so this stays a short explicit-trust list, not a directory.
 */
export const MAX_INVITE_VOUCHES = 8;

export interface SignedInvite {
  service: string;
  inviter: string;
  note: string;
  sig: string;
  /** Ed pubkey hexes the inviter explicitly trusts. Absent when empty. */
  vouches?: string[];
}

function parseVouchHex(vouch: unknown): Uint8Array {
  if (typeof vouch !== 'string' || !/^[0-9a-f]{64}$/i.test(vouch.trim())) {
    throw new Error('vouch must be a 32-byte pubkey in hex');
  }
  return hexToBytes(vouch.trim().toLowerCase());
}

/**
 * Sign an invite. Byte-exact mirror of `nym-hidden-service/src/invite.rs`.
 *
 * Vouches ride inside the signed bytes: `… || note || 0x00 || count || vouch…`
 * when present, plain `… || note` when absent (byte-identical to legacy
 * links, which keep verifying). Stripping vouches breaks the signature, so
 * a tampered link is rejected, never silently downgraded.
 */
export function signInvite(
  privHex: string,
  serviceUri: string,
  note: string,
  vouches: string[] = [],
): SignedInvite {
  if (!note || note.length > 140) throw new Error('note must be 1-140 chars');
  const svc = parseNymAddress(serviceUri);
  const inviter = ed25519.getPublicKey(hexToBytes(privHex));
  const inviterHex = bytesToHex(inviter);
  // A self-vouch is meaningless: drop it rather than fail the whole invite.
  const clean = [...new Set(vouches.map((v) => v.trim().toLowerCase()))].filter(
    (v) => v !== inviterHex,
  );
  const vouchBytes = clean.map(parseVouchHex);
  if (vouchBytes.length > MAX_INVITE_VOUCHES) {
    throw new Error(`at most ${MAX_INVITE_VOUCHES} vouches per invite`);
  }
  const tail =
    vouchBytes.length === 0
      ? []
      : [new Uint8Array([0, vouchBytes.length]), ...vouchBytes];
  const msg = concat(
    enc.encode(INVITE_DOMAIN),
    base58Decode(svc.identity),
    base58Decode(svc.encryption),
    base58Decode(svc.gateway),
    inviter,
    enc.encode(note),
    ...tail,
  );
  const out: SignedInvite = {
    service: serviceUri.startsWith('nym://') ? serviceUri : `nym://${serviceUri}`,
    inviter: inviterHex,
    note,
    sig: bytesToHex(ed25519.sign(msg, hexToBytes(privHex))),
  };
  if (clean.length > 0) out.vouches = clean;
  return out;
}

/** Verify an invite against the link address carrying it. Returns false on any defect. */
export function verifyInvite(
  invite: SignedInvite,
  linkAddress: string,
): boolean {
  try {
    if (!invite.note || invite.note.length > 140) return false;
    const svc = parseNymAddress(invite.service);
    const outer = parseNymAddress(linkAddress);
    if (svc.identity !== outer.identity || svc.encryption !== outer.encryption || svc.gateway !== outer.gateway) {
      return false; // bait-and-switch
    }
    const rawVouches = invite.vouches ?? [];
    if (!Array.isArray(rawVouches) || rawVouches.length > MAX_INVITE_VOUCHES) return false;
    const vouchBytes = rawVouches.map(parseVouchHex);
    const tail =
      vouchBytes.length === 0
        ? []
        : [new Uint8Array([0, vouchBytes.length]), ...vouchBytes];
    const msg = concat(
      enc.encode(INVITE_DOMAIN),
      base58Decode(svc.identity),
      base58Decode(svc.encryption),
      base58Decode(svc.gateway),
      hexToBytes(invite.inviter),
      enc.encode(invite.note),
      ...tail,
    );
    return ed25519.verify(hexToBytes(invite.sig), msg, hexToBytes(invite.inviter));
  } catch {
    return false;
  }
}

/**
 * Encrypted identity backup for moving an ID with a file instead of a raw
 * secret hex. Format (JSON, versioned):
 *
 * ```text
 * { v: 1, kdf: 'argon2id', t, m, p, saltB64, nonceB64, ctB64 }
 * key = argon2id(password, salt, t, m, p)
 * ct  = XChaCha20-Poly1305(key, nonce).encrypt(privkey)
 * ```
 *
 * Anyone with the file *and* the password is you: store them separately.
 * The hex export ("Move my ID") keeps working as the low-tech fallback.
 */

export const BACKUP_KDF_T = 3;
/** 32 MiB: ~1s on desktop, heavier on old phones — the price of the file. */
export const BACKUP_KDF_M = 32 * 1024;
export const BACKUP_KDF_P = 1;
export const BACKUP_MIN_PASSWORD_LENGTH = 8;

export interface IdentityBackup {
  v: 1;
  kdf: 'argon2id';
  t: number;
  m: number;
  p: number;
  saltB64: string;
  nonceB64: string;
  ctB64: string;
}

function b64encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function b64decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Encrypt the private key to a portable JSON backup. Takes ~1s (KDF cost). */
export async function exportIdentityBackup(privHex: string, password: string): Promise<string> {
  if (!password || password.length < BACKUP_MIN_PASSWORD_LENGTH) {
    throw new Error(`backup password must be at least ${BACKUP_MIN_PASSWORD_LENGTH} characters`);
  }
  if (!/^[0-9a-f]{64}$/i.test(privHex.trim())) throw new Error('private key must be 32 bytes hex');
  const priv = hexToBytes(privHex.trim().toLowerCase());
  const salt = randomBytes(16);
  const key = await argon2idAsync(enc.encode(password), salt, {
    t: BACKUP_KDF_T,
    m: BACKUP_KDF_M,
    p: BACKUP_KDF_P,
    dkLen: 32,
  });
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(priv);
  key.fill(0);
  const backup: IdentityBackup = {
    v: 1,
    kdf: 'argon2id',
    t: BACKUP_KDF_T,
    m: BACKUP_KDF_M,
    p: BACKUP_KDF_P,
    saltB64: b64encode(salt),
    nonceB64: b64encode(nonce),
    ctB64: b64encode(ct),
  };
  return JSON.stringify(backup);
}

/**
 * Decrypt a backup and adopt the identity (persists like an import).
 * Throws on wrong password, corruption, or absurd KDF params (a malicious
 * file must not be able to OOM the tab via a giant memory cost).
 */
export async function importIdentityBackup(json: string, password: string): Promise<Identity> {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error('backup is not valid JSON');
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('backup must be an object');
  }
  const b = obj as Record<string, unknown>;
  if (b.v !== 1 || b.kdf !== 'argon2id') throw new Error('unsupported backup version');
  for (const [field, min, max] of [['t', 1, 10], ['m', 8192, 131072], ['p', 1, 4]] as const) {
    const value = b[field];
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      throw new Error(`backup has an unsafe ${field} parameter`);
    }
  }
  let salt: Uint8Array;
  let nonce: Uint8Array;
  let ct: Uint8Array;
  try {
    if (typeof b.saltB64 !== 'string' || typeof b.nonceB64 !== 'string' || typeof b.ctB64 !== 'string') {
      throw new Error('shape');
    }
    salt = b64decode(b.saltB64);
    nonce = b64decode(b.nonceB64);
    ct = b64decode(b.ctB64);
  } catch {
    throw new Error('backup fields are not valid base64');
  }
  if (salt.length !== 16 || nonce.length !== 24 || ct.length !== 48) {
    throw new Error('backup has the wrong shape');
  }
  const key = await argon2idAsync(enc.encode(password), salt, {
    t: b.t as number,
    m: b.m as number,
    p: b.p as number,
    dkLen: 32,
  });
  let priv: Uint8Array;
  try {
    priv = xchacha20poly1305(key, nonce).decrypt(ct);
  } catch {
    throw new Error('backup password wrong or file corrupted');
  } finally {
    key.fill(0);
  }
  if (priv.length !== 32) throw new Error('backup password wrong or file corrupted');
  return importIdentity(bytesToHex(priv));
}
