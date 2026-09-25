/**
 * Real ed25519 verification for portal log entries and objects.
 *
 * Static noble import (same policy as `./identity.ts`); this module is only
 * imported where a browser exists — the pure structural code in
 * `./portalSync.ts` never touches it, so `node --test web/test` covers
 * portalSync offline. Tests exercising these functions use the dynamic-import
 * skip pattern (see `web/test/dm-crypto.test.mjs`).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { portalEntryBytes, portalObjectSigningBytes, type PortalLogEntry, type PortalObject } from './portalSync';

/** Verify an author's log-entry signature (mirror of `Log::append` in portal-data). */
export function verifyLogEntrySig(entry: PortalLogEntry): boolean {
  try {
    return ed25519.verify(
      hexToBytes(entry.sig),
      portalEntryBytes(entry.author, entry.seq, entry.objId),
      hexToBytes(entry.author),
    );
  } catch {
    return false;
  }
}

/** Verify an object's signature over `fly-portal-v1/object` signing bytes. */
export function verifyObjectSig(obj: PortalObject): boolean {
  try {
    return ed25519.verify(
      hexToBytes(obj.sig),
      portalObjectSigningBytes(obj.author, obj.kind, obj.payload),
      hexToBytes(obj.author),
    );
  } catch {
    return false;
  }
}