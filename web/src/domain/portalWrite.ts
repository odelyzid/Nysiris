/**
 * Browser-side portal authoring primitives.
 *
 * Builds the same signed bytes as `portal-data` (object id = SHA256(signing ||
 * signature), log entry signature over domain/author/seq/obj_id). Transport and
 * PoW live in `portalWriteIo.ts`; these functions are pure enough to test.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Identity } from '../domain/identity.ts';
import { encodePortalContent, parsePortalContent, type PortalContent } from '../domain/portalContent.ts';
import { b64encode } from '../lib/bytes.ts';
import {
  portalEntryBytes,
  portalObjectSigningBytes,
  type PortalLogEntry,
  type PortalObject,
  type PortalReplica,
} from '../domain/portalSync.ts';

export interface PortalPublishBundle {
  object: PortalObject;
  entry: PortalLogEntry;
}

/** Next log sequence for this author in the local replica. */
export function nextPortalSeq(replica: PortalReplica, author: string): number {
  return replica.entriesByAuthor[String(author ?? '').toLowerCase()]?.length ?? 0;
}

/** Build + sign one object payload. Throws on schema/type/size defects. */
export async function buildPortalObject(
  identity: Identity,
  kind: string,
  content: PortalContent,
): Promise<PortalObject> {
  if (!/^[a-z0-9/_-]{1,64}$/.test(kind)) throw new Error('invalid portal object kind');
  // Round-trip through the parser: an author cannot publish a payload readers
  // would reject.
  const payload = encodePortalContent(content);
  if (!parsePortalContent(kind, payload)) throw new Error('portal payload does not match its kind schema');
  const authorBytes = hexToBytes(identity.pubHex);
  if (authorBytes.length !== 32) throw new Error('portal author key must be 32 bytes');
  const secret = hexToBytes(identity.privHex);
  const sigBytes = ed25519.sign(portalObjectSigningBytes(identity.pubHex, kind, payload), secret);
  const sig = bytesToHex(sigBytes);
  const id = await computePortalObjectId(identity.pubHex, kind, payload, sig);
  return {
    id,
    kind,
    author: identity.pubHex.toLowerCase(),
    payload,
    sig,
  };
}

/** Sign the log entry that makes an object part of the author's history. */
export function buildPortalLogEntry(identity: Identity, seq: number, objId: string): PortalLogEntry {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('seq must be a non-negative integer');
  if (!/^[0-9a-f]{64}$/i.test(objId)) throw new Error('objId must be 32 bytes hex');
  const author = identity.pubHex.toLowerCase();
  const sig = bytesToHex(ed25519.sign(portalEntryBytes(author, seq, objId), hexToBytes(identity.privHex)));
  return { author, seq, objId: objId.toLowerCase(), sig };
}

/** Object id exactly as `portal_data::compute_id`. */
export async function computePortalObjectId(
  author: string,
  kind: string,
  payload: Uint8Array,
  sig: string,
): Promise<string> {
  const signing = portalObjectSigningBytes(author, kind, payload);
  const signature = hexToBytes(sig);
  const bytes = new Uint8Array(signing.length + signature.length);
  bytes.set(signing, 0);
  bytes.set(signature, signing.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return bytesToHex(digest);
}

/** Add a successfully published bundle to the local replica. */
export function applyPortalBundle(replica: PortalReplica, bundle: PortalPublishBundle): PortalReplica {
  const author = bundle.entry.author.toLowerCase();
  const existing = replica.entriesByAuthor[author] ?? [];
  if (bundle.entry.seq !== existing.length) {
    throw new Error(`local log head is ${existing.length}; expected seq ${bundle.entry.seq}`);
  }
  return {
    entriesByAuthor: { ...replica.entriesByAuthor, [author]: [...existing, bundle.entry] },
    objectsById: { ...replica.objectsById, [bundle.object.id]: bundle.object },
  };
}

/** Build the object and its next log entry together. */
export async function buildPortalPublish(
  identity: Identity,
  kind: string,
  content: PortalContent,
  replica: PortalReplica,
): Promise<PortalPublishBundle> {
  const object = await buildPortalObject(identity, kind, content);
  const entry = buildPortalLogEntry(identity, nextPortalSeq(replica, identity.pubHex), object.id);
  return { object, entry };
}

/** Wire JSON for `POST /obj` (canonical `Object::to_json` plus optional PoW). */
export function objectRequestJson(
  bundle: PortalPublishBundle,
  pow: { nonce: number; bits: number } | null,
): Record<string, unknown> {
  return {
    v: 1,
    kind: bundle.object.kind,
    author: bundle.object.author,
    payload: b64encode(bundle.object.payload),
    sig: bundle.object.sig,
    id: bundle.object.id,
    ...(pow ? { pow } : {}),
  };
}

/** Wire JSON for `POST /log-entry`. */
export function logEntryRequestJson(
  bundle: PortalPublishBundle,
  pow: { nonce: number; bits: number } | null,
): Record<string, unknown> {
  return {
    author: bundle.entry.author,
    seq: bundle.entry.seq,
    obj_id: bundle.entry.objId,
    sig: bundle.entry.sig,
    ...(pow ? { pow } : {}),
  };
}
