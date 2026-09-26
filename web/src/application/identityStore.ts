/**
 * Identity persistence: localStorage + the Android keystore plugin.
 *
 * Strategy: the keystore is authoritative when reachable; the localStorage
 * cache is the desktop fallback. Every secure write goes to the keystore
 * first; when it succeeds, the cache is rewritten as a **token-wrapped copy**
 * (XChaCha under a random key held in the keystore), so WebView storage alone
 * never holds `privHex` on Android. On devices without the plugin the cache
 * stays plaintext, exactly as before. Reads: the app uses the async
 * `loadIdentitySecure()`; the sync `loadIdentity()` remains the plaintext
 * fallback for legacy callers and deliberately cannot read wrapped values.
 * The stored value is the same `{ privHex, pubHex }` JSON used by the social
 * identity slot — carried over the plugin boundary as base64 bytes (the Java
 * side base64-encodes on read, mirroring `keystoreSet`'s base64 input).
 *
 * Re-exports the pure identity rules (`../domain/identity`) so existing
 * importers keep a single entry point while signing/verification stays in the
 * domain layer.
 */
export * from '../domain/identity.ts';

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { decryptIdentityBackup, type Identity } from '../domain/identity.ts';
import { b64decode, b64encode } from '../lib/bytes.ts';
import { isKeystoreAvailable, keystoreGet, keystoreRemove, keystoreSet } from '../adapters/driven/keystore.mjs';

const STORAGE_KEY = 'fly.social.identity';

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

/**
 * Portal-service identity: a *separate* keypair from the social identity
 * (`fly.portal.identity`). The service's Nym address derives from its client
 * keys when it starts (written to `nym-address.txt`); this keypair is the
 * one you control directly — keep it to re-publish from the same address.
 * Same ed25519 key logic as the social identity, different slot.
 */
const PORTAL_IDENTITY_KEY = 'fly.portal.identity';

export function loadIdentity(): Identity | null {
  return parseIdentityJson(kv().getItem(STORAGE_KEY));
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

export function loadPortalIdentity(): Identity | null {
  try {
    return parseIdentityJson(kv().getItem(PORTAL_IDENTITY_KEY));
  } catch {
    return null;
  }
}

export function createPortalIdentity(): Identity {
  const priv = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(priv);
  const id = { privHex: bytesToHex(priv), pubHex: bytesToHex(pub) };
  kv().setItem(PORTAL_IDENTITY_KEY, JSON.stringify(id));
  return id;
}

export function importPortalIdentity(privHex: string): Identity {
  const priv = hexToBytes(privHex.trim().toLowerCase());
  if (priv.length !== 32) throw new Error('private key must be 32 bytes hex');
  const pub = ed25519.getPublicKey(priv);
  const id = { privHex: bytesToHex(priv), pubHex: bytesToHex(pub) };
  kv().setItem(PORTAL_IDENTITY_KEY, JSON.stringify(id));
  return id;
}

const KEYSTORE_NAME = 'social.identity';
/** Keystore slot for the random key that wraps the localStorage cache. */
const CACHE_WRAP_NAME = 'social.identity.cache-key';
/** Prefix marking a token-wrapped (non-plaintext) cache value. */
const WRAP_PREFIX = 'fly-ks-v1.';

function parseIdentityJson(raw: string | null): Identity | null {
  if (!raw) return null;
  try {
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

/**
 * The keystore plugin speaks base64 bytes (the Java side base64-encodes on
 * read, mirroring `keystoreSet`'s base64 input), so decode before parsing.
 * Garbage, absence, and unavailability all degrade to `null`.
 */
function parseKeystoreIdentity(rawB64: string | null): Identity | null {
  if (!rawB64) return null;
  try {
    return parseIdentityJson(atob(rawB64));
  } catch {
    return null;
  }
}

/**
 * Wrap the identity JSON under `key` (XChaCha20-Poly1305):
 * `fly-ks-v1.<b64(nonce)>.<b64(ct)>`. The prefix makes a wrapped value
 * unparseable by the sync plaintext readers, fail-closed.
 */
function wrapJson(key: Uint8Array, json: string): string {
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(json));
  return `${WRAP_PREFIX}${b64encode(nonce)}.${b64encode(ciphertext)}`;
}

/** Inverse of `wrapJson`; `null` on any tampering or key mismatch. */
function unwrapJson(key: Uint8Array, raw: string): Identity | null {
  if (!raw.startsWith(WRAP_PREFIX)) return null;
  const [nonceB64, ctB64] = raw.slice(WRAP_PREFIX.length).split('.');
  if (!nonceB64 || !ctB64) return null;
  try {
    const plain = xchacha20poly1305(key, b64decode(nonceB64)).decrypt(b64decode(ctB64));
    return parseIdentityJson(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

/** Random cache-wrap key, held in the Keystore so WebView storage alone can never read the cache. */
async function cacheWrapKey(): Promise<Uint8Array> {
  const existing = await keystoreGet(CACHE_WRAP_NAME);
  if (existing) {
    const key = b64decode(existing);
    if (key.length === 32) return key;
  }
  const key = randomBytes(32);
  await keystoreSet(CACHE_WRAP_NAME, b64encode(key));
  return key;
}

/**
 * Refresh the cache for `id`: token-wrapped when the Keystore is available
 * (WebView storage never holds plaintext), plaintext only on devices without
 * the plugin, empty when wrapping fails (no plaintext rather than a leak).
 */
async function writeCache(id: Identity, plaintextAllowed: boolean): Promise<void> {
  const json = JSON.stringify(id);
  if (!plaintextAllowed) {
    try {
      const key = await cacheWrapKey();
      kv().setItem(STORAGE_KEY, wrapJson(key, json));
      return;
    } catch {
      kv().setItem(STORAGE_KEY, '');
      return;
    }
  }
  kv().setItem(STORAGE_KEY, json);
}

/** Persist to keystore (when available); the cache follows the keystore rules. */
export async function persistIdentitySecure(id: Identity): Promise<{ keystore: boolean }> {
  const stored = await keystoreSet(KEYSTORE_NAME, btoa(JSON.stringify(id))).catch(() => ({
    available: false as const,
  }));
  if (!stored.available) {
    // Desktop / no plugin: the plaintext cache is all there is (unchanged).
    kv().setItem(STORAGE_KEY, JSON.stringify(id));
    return { keystore: false };
  }
  await writeCache(id, false);
  return { keystore: true };
}

/**
 * Load the identity, preferring the keystore. Falls back to the cache —
 * plain (legacy / desktop) or token-wrapped — and heals the keystore from it
 * when reachable. The sync `loadIdentity()` stays plaintext-only and returns
 * `null` for wrapped values; the app must use this async path at startup.
 */
export async function loadIdentitySecure(): Promise<Identity | null> {
  const fromKeystore = parseKeystoreIdentity(await keystoreGet(KEYSTORE_NAME));
  if (fromKeystore) {
    await writeCache(fromKeystore, !isKeystoreAvailable());
    return fromKeystore;
  }
  const cached = await cachedIdentity();
  if (cached && isKeystoreAvailable()) {
    // Heal: put the identity back into the Keystore (and re-wrap the cache).
    await persistIdentitySecure(cached).catch(() => undefined);
  }
  return cached;
}

/** Cache reader: plain JSON (legacy/desktop) or token-wrapped (Keystore). */
async function cachedIdentity(): Promise<Identity | null> {
  const raw = kv().getItem(STORAGE_KEY);
  if (!raw) return null;
  if (!raw.startsWith(WRAP_PREFIX)) return parseIdentityJson(raw);
  try {
    const key = await cacheWrapKey();
    return unwrapJson(key, raw);
  } catch {
    return null;
  }
}

/**
 * One-time upgrade: copy a localStorage-only identity into the keystore.
 * Returns `'migrated'`, `'unavailable'` (no plugin — nothing to do), or
 * `'absent'` (no identity to migrate).
 */
export async function migrateIdentityToKeystore(): Promise<'migrated' | 'unavailable' | 'absent'> {
  if (!isKeystoreAvailable()) return 'unavailable';
  if (parseKeystoreIdentity(await keystoreGet(KEYSTORE_NAME))) return 'migrated';
  const cached = await cachedIdentity();
  if (!cached) return 'absent';
  await persistIdentitySecure(cached);
  return 'migrated';
}

/** Forget the identity everywhere (keystore + cache + cache-wrap key). */
export async function clearIdentitySecure(): Promise<void> {
  try {
    kv().setItem(STORAGE_KEY, '');
  } catch {
    // Cache clear is best-effort; the keystore removal below is what matters.
  }
  await keystoreRemove(KEYSTORE_NAME).catch(() => undefined);
  // Without the wrap key any remaining wrapped cache is unreadable.
  await keystoreRemove(CACHE_WRAP_NAME).catch(() => undefined);
}

/** Decrypt a backup and adopt the identity (persists like an import). */
export async function importIdentityBackup(json: string, password: string): Promise<Identity> {
  const decrypted = await decryptIdentityBackup(json, password);
  return importIdentity(decrypted.privHex);
}
