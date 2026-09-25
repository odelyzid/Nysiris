/**
 * Identity persistence: localStorage + the Android keystore plugin.
 *
 * Strategy: the keystore is authoritative when reachable; localStorage stays
 * as a fallback cache so desktop browsers (no plugin) keep working unchanged.
 * Every write goes to both; every read prefers the keystore. The stored value
 * is the same `{ privHex, pubHex }` JSON used by the social identity slot.
 *
 * Re-exports the pure identity rules (`../domain/identity`) so existing
 * importers keep a single entry point while signing/verification stays in the
 * domain layer.
 */
export * from '../domain/identity.ts';

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { decryptIdentityBackup, type Identity } from '../domain/identity.ts';
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

/** Persist to keystore (when available) and always to the localStorage cache. */
export async function persistIdentitySecure(id: Identity): Promise<{ keystore: boolean }> {
  kv().setItem(STORAGE_KEY, JSON.stringify(id));
  const stored = await keystoreSet(KEYSTORE_NAME, btoa(JSON.stringify(id))).catch(() => ({
    available: false as const,
  }));
  return { keystore: stored.available };
}

/**
 * Load the identity, preferring the keystore. Falls back to the
 * localStorage cache (and heals the keystore from it when reachable).
 */
export async function loadIdentitySecure(): Promise<Identity | null> {
  const fromKeystore = parseIdentityJson(await keystoreGet(KEYSTORE_NAME));
  if (fromKeystore) {
    kv().setItem(STORAGE_KEY, JSON.stringify(fromKeystore));
    return fromKeystore;
  }
  const cached = loadIdentity();
  if (cached && isKeystoreAvailable()) {
    await persistIdentitySecure(cached).catch(() => undefined);
  }
  return cached;
}

/**
 * One-time upgrade: copy a localStorage-only identity into the keystore.
 * Returns `'migrated'`, `'unavailable'` (no plugin — nothing to do), or
 * `'absent'` (no identity to migrate).
 */
export async function migrateIdentityToKeystore(): Promise<'migrated' | 'unavailable' | 'absent'> {
  if (!isKeystoreAvailable()) return 'unavailable';
  if (parseIdentityJson(await keystoreGet(KEYSTORE_NAME))) return 'migrated';
  const cached = loadIdentity();
  if (!cached) return 'absent';
  await persistIdentitySecure(cached);
  return 'migrated';
}

/** Forget the identity everywhere (keystore + local cache). */
export async function clearIdentitySecure(): Promise<void> {
  try {
    kv().setItem(STORAGE_KEY, '');
  } catch {
    // Cache clear is best-effort; the keystore removal below is what matters.
  }
  await keystoreRemove(KEYSTORE_NAME).catch(() => undefined);
}

/** Decrypt a backup and adopt the identity (persists like an import). */
export async function importIdentityBackup(json: string, password: string): Promise<Identity> {
  const decrypted = await decryptIdentityBackup(json, password);
  return importIdentity(decrypted.privHex);
}
