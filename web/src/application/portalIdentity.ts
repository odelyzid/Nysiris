/**
 * Fresh signing identity per portal.
 *
 * A portal author key is deliberately not the social identity and not the
 * portal-service key: publishing to portal A must not link to portal B (or to
 * the user's social posts). Storage is injected and keyed by canonical scope.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Identity } from '../domain/identity.ts';
import type { StorageLike } from '../lib/storage.ts';

export const PORTAL_AUTHOR_KEY_PREFIX = 'fly.portal.author.v1.';

export function portalAuthorStorageKey(scope: string): string {
  return `${PORTAL_AUTHOR_KEY_PREFIX}${encodeURIComponent(String(scope ?? '').trim())}`;
}

export function loadPortalAuthor(storage: StorageLike | null, scope: string): Identity | null {
  if (!scope.trim()) return null;
  try {
    const raw = storage?.getItem(portalAuthorStorageKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Identity>;
    return validIdentity(parsed?.privHex, parsed?.pubHex);
  } catch {
    return null;
  }
}

/**
 * Create a portal-scoped key. `secretHex` is for import/tests; when omitted a
 * fresh 32-byte secret is generated.
 */
export function createPortalAuthor(storage: StorageLike | null, scope: string, secretHex?: string): Identity {
  const cleanScope = String(scope ?? '').trim();
  if (!cleanScope) throw new Error('a portal scope is required before creating an author key');
  if (secretHex !== undefined && !/^[0-9a-f]{64}$/i.test(String(secretHex).trim())) {
    throw new Error('portal author secret must be 32 bytes hex');
  }
  const secret = secretHex ? hexToBytes(secretHex.trim().toLowerCase()) : ed25519.utils.randomSecretKey();
  if (secret.length !== 32) throw new Error('portal author secret must be 32 bytes hex');
  const identity: Identity = {
    privHex: bytesToHex(secret),
    pubHex: bytesToHex(ed25519.getPublicKey(secret)),
  };
  try {
    storage?.setItem(portalAuthorStorageKey(cleanScope), JSON.stringify(identity));
  } catch {
    // Private mode: the key lives only for this call.
  }
  return identity;
}

export function importPortalAuthor(storage: StorageLike | null, scope: string, privHex: string): Identity {
  return createPortalAuthor(storage, scope, privHex);
}

export function removePortalAuthor(storage: StorageLike | null, scope: string): void {
  if (!scope.trim()) return;
  try {
    storage?.setItem(portalAuthorStorageKey(scope), '');
  } catch {
    // Nothing to remove.
  }
}

function validIdentity(privHex: unknown, pubHex: unknown): Identity | null {
  if (typeof privHex !== 'string' || !/^[0-9a-f]{64}$/i.test(privHex)) return null;
  if (typeof pubHex !== 'string' || !/^[0-9a-f]{64}$/i.test(pubHex)) return null;
  try {
    const expected = bytesToHex(ed25519.getPublicKey(hexToBytes(privHex)));
    return expected === pubHex.toLowerCase() ? { privHex: privHex.toLowerCase(), pubHex: pubHex.toLowerCase() } : null;
  } catch {
    return null;
  }
}
