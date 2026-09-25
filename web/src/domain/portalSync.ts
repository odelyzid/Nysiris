/**
 * Browser TS port of the portal replication protocol. Byte-exact mirror of
 * `crates/portal-replication` + `crates/portal-data` (see especially the
 * golden vectors in `crates/portal-replication/tests/golden.rs`, which pin
 * the wire the parsers here must reproduce).
 *
 * The browser drives the same client-side gossip the provider serves:
 * `GET /heads` → diff against our heads → `GET /log/<author>?since=<hold>` →
 * verified, atomic apply → `GET /obj/<id>` for anything we don't hold yet.
 * Forks are never merged: an author whose batch breaks continuity or fails
 * signature verification is flagged, not applied.
 *
 * Everything here is pure and dependency-free (no `@noble/*` at import
 * time): signature verification is *injected* as `verifyEntry` / `verifySig`
 * callbacks so `node --test web/test` covers all structure offline. The real
 * ed25519 calls live in `./portalVerify.ts`.
 */

import { b64decode, b64encode, bytesToHex, hexToBytes, u64be } from '../lib/bytes.ts';

/** Canonical signing domains — frozen, match `portal-data` exactly. */
export const LOG_ENTRY_DOMAIN = 'fly-portal-v1/log-entry';
export const OBJECT_DOMAIN = 'fly-portal-v1/object';

/** Payload cap mirror (`portal_data::object::MAX_OBJECT_BYTES`). */
export const MAX_OBJECT_BYTES = 16 * 1024;
/** Max `kind` length mirror (`portal_data::object::MAX_KIND_LEN`). */
export const MAX_KIND_LEN = 64;
/** Cap on kept objects in a replica: recent history, not an archive. */
export const MAX_KEPT_OBJECTS = 200;

/** Frozen storage key — rename breaks nothing today but loses synced data. */
export const PORTAL_SYNC_KEY = 'fly.portal.sync.v1';

export interface PortalLogEntry {
  /** Author public key (32 bytes, lowercase hex). */
  author: string;
  /** Position in the author's log (must equal the log length on ingest). */
  seq: number;
  /** Content-addressed object id (32 bytes, lowercase hex). */
  objId: string;
  /** ed25519 signature (64 bytes, lowercase hex). */
  sig: string;
}

export interface PortalObject {
  /** Content id (32 bytes, lowercase hex): `SHA256(signing_bytes || sig)`. */
  id: string;
  /** Namespaced value (`post`, `profile`, `dm-chunk`, …), `[a-z0-9/_-]{1,64}`. */
  kind: string;
  /** Author public key (32 bytes, lowercase hex). */
  author: string;
  /** Raw payload (base64 on the wire, bytes in the record). */
  payload: Uint8Array;
  /** ed25519 signature (64 bytes, lowercase hex). */
  sig: string;
}

/** A local partial replica: per-author logs plus verified objects. */
export interface PortalReplica {
  entriesByAuthor: Record<string, PortalLogEntry[]>;
  objectsById: Record<string, PortalObject>;
}

export interface PortalWant {
  author: string;
  fromSeq: number;
}

export interface PortalSyncStatus {
  syncing: boolean;
  lastSyncedAt: number | null;
  error: string | null;
}

export function emptyReplica(): PortalReplica {
  return { entriesByAuthor: {}, objectsById: {} };
}

/** Per-author heads, derived (mirror of `Replica::heads` — no stored drift). */
export function portalHeads(replica: PortalReplica): Record<string, number> {
  const heads: Record<string, number> = {};
  for (const [author, entries] of Object.entries(replica.entriesByAuthor)) {
    heads[author] = entries.length;
  }
  return heads;
}

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

function hexSize(value: unknown, bytes: number, what: string): string {
  const s = typeof value === 'string' ? value : '';
  const clean = s.trim().toLowerCase();
  assert(HEX_RE.test(clean) && clean.length === bytes * 2, `${what} must be ${bytes} bytes hex`);
  return clean;
}

function uintSeq(value: unknown, what: string): number {
  assert(Number.isInteger(value) && (value as number) >= 0, `${what} must be a non-negative integer`);
  return value as number;
}

const HEX_RE = /^[0-9a-f]+$/;

/**
 * Parse a `GET /heads` reply:
 * `{"heads":[{"author":hex,"seq":n}, …]}` → map `{author: seq}`.
 * Fails closed on every shape or hex defect.
 */
export function parsePortalHeadsReply(json: unknown): Record<string, number> {
  const root = json as { heads?: unknown };
  assert(root !== null && typeof root === 'object' && Array.isArray(root.heads), 'heads reply must be {"heads":[...]}');
  const heads: Record<string, number> = {};
  for (const item of root.heads as unknown[]) {
    assert(item !== null && typeof item === 'object', 'heads list item must be an object');
    const pair = item as { author?: unknown; seq?: unknown };
    const author = hexSize(pair.author, 32, 'head author');
    const seq = uintSeq(pair.seq, 'head seq');
    heads[author] = seq;
  }
  return heads;
}

/**
 * Parse a `GET /log/<author>?since=n` reply:
 * `{"entries":[{"author","obj_id","seq","sig"}, …], "head":m}` with every
 * entry at `seq >= since`. When `expectFrom` is given, the first entry must
 * start exactly there (the diff said we hold `fromSeq`).
 */
export function parsePortalLogReply(json: unknown, expectFrom?: number): { entries: PortalLogEntry[]; head: number } {
  const root = json as { entries?: unknown; head?: unknown };
  assert(
    root !== null && typeof root === 'object' && Array.isArray(root.entries),
    'log reply must be {"entries":[...],"head":n}',
  );
  const entries: PortalLogEntry[] = [];
  let prev = -1;
  for (const item of root.entries as unknown[]) {
    assert(item !== null && typeof item === 'object', 'log entry must be an object');
    const raw = item as { author?: unknown; seq?: unknown; obj_id?: unknown; sig?: unknown };
    const author = hexSize(raw.author, 32, 'entry author');
    const objId = hexSize(raw.obj_id, 32, 'entry obj_id');
    const sig = hexSize(raw.sig, 64, 'entry sig');
    const seq = uintSeq(raw.seq, 'entry seq');
    assert(seq > prev, 'entries must be strictly ascending by seq');
    prev = seq;
    entries.push({ author, seq, objId, sig });
  }
  if (expectFrom !== undefined && entries.length > 0) {
    assert(entries[0].seq === expectFrom, `expected first seq ${expectFrom}, got ${entries[0].seq}`);
  }
  const head = uintSeq(root.head, 'log head');
  return { entries, head };
}

/** The bytes an ed25519 log-entry signature covers (mirror of `entry_bytes`). */
export function portalEntryBytes(author: string, seq: number, objId: string): Uint8Array {
  const enc = new TextEncoder();
  const out = new Uint8Array(enc.encode(LOG_ENTRY_DOMAIN).length + 32 + 8 + 32);
  let at = 0;
  out.set(enc.encode(LOG_ENTRY_DOMAIN), at);
  at += enc.encode(LOG_ENTRY_DOMAIN).length;
  out.set(hexToBytes(author), at);
  at += 32;
  out.set(u64be(seq), at);
  at += 8;
  out.set(hexToBytes(objId), at);
  return out;
}

/** Compute what a peer advertises that `local` is missing (mirror of `diff_wants`). */
export function diffPortalWants(local: Record<string, number>, peer: Record<string, number>): PortalWant[] {
  const wants = Object.entries(peer)
    .filter(([author, peerSeq]) => peerSeq > (local[author] ?? 0))
    .map(([author]) => ({ author, fromSeq: local[author] ?? 0 }));
  // Byte-order sort, matching the Rust `diff_wants` reference exactly.
  wants.sort((a, b) => (a.author < b.author ? -1 : a.author > b.author ? 1 : 0));
  return wants;
}

/**
 * Verify and apply one author's fetched entries to the replica. Mirrors
 * `Replica::apply_entries`: same author throughout, `seq` continuing exactly
 * at the local log length, signatures verified by the injected
 * `verifyEntry`. Any defect rejects the whole batch atomically — `replica`
 * is returned untouched.
 */
export async function mergePortalEntries(
  replica: PortalReplica,
  entries: PortalLogEntry[],
  verifyEntry: (entry: PortalLogEntry) => Promise<boolean> | boolean,
): Promise<{ replica: PortalReplica; applied: number }> {
  if (entries.length === 0) return { replica, applied: 0 };
  const author = entries[0].author;
  const stage = [...(replica.entriesByAuthor[author] ?? [])];
  for (const entry of entries) {
    if (entry.author !== author) throw new Error('batch mixes authors');
    const expected = stage.length;
    if (entry.seq !== expected) {
      throw new Error(`expected seq ${expected}, got ${entry.seq} (fork or gap)`);
    }
    const ok = await verifyEntry(entry);
    if (!ok) throw new Error('bad entry signature');
    stage.push(entry);
  }
  return {
    replica: {
      ...replica,
      entriesByAuthor: { ...replica.entriesByAuthor, [author]: stage },
    },
    applied: entries.length,
  };
}

/** Parse a `GET /obj/<id>` reply into a record, validating shape + hex. */
export function parsePortalObjectReply(json: unknown): PortalObject {
  const root = json as { id?: unknown; kind?: unknown; author?: unknown; payload?: unknown; sig?: unknown };
  assert(root !== null && typeof root === 'object', 'object reply must be a JSON object');
  const id = hexSize(root.id, 32, 'object id');
  const author = hexSize(root.author, 32, 'object author');
  const sig = hexSize(root.sig, 64, 'object sig');
  const kind = typeof root.kind === 'string' ? root.kind : '';
  assert(
    kind.length >= 1 && kind.length <= MAX_KIND_LEN && /^[a-z0-9/_-]+$/.test(kind),
    `kind must be 1-${MAX_KIND_LEN} chars of [a-z0-9/_-]`,
  );
  let payload: Uint8Array;
  try {
    payload = b64decode(typeof root.payload === 'string' ? root.payload : '');
  } catch {
    throw new Error('object payload is not valid base64');
  }
  assert(payload.length <= MAX_OBJECT_BYTES, 'object exceeds size cap');
  return { id, kind, author, payload, sig };
}

/** Signing bytes an object signature covers (mirror of `object::signing_bytes`). */
export function portalObjectSigningBytes(author: string, kind: string, payload: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const parts = [enc.encode(OBJECT_DOMAIN), hexToBytes(author), enc.encode(kind), new Uint8Array([0]), payload];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Recompute an object's content id: `SHA256(signing_bytes || sig)`. Fails
 * closed if it doesn't match the claimed `id` — the id binds author + kind +
 * payload + signature, so any tampering is caught here (mirror of
 * `Object::parse_untrusted`).
 */
export async function verifyPortalObjectId(obj: PortalObject): Promise<boolean> {
  const sigBytes = hexToBytes(obj.sig);
  const signing = portalObjectSigningBytes(obj.author, obj.kind, obj.payload);
  const toHash = new Uint8Array(signing.length + sigBytes.length);
  toHash.set(signing, 0);
  toHash.set(sigBytes, signing.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toHash));
  return bytesToHex(digest) === obj.id;
}

/** Persisted wire for one object: payload base64 (JSON cannot carry bytes). */
export function serializeObject(obj: PortalObject): Record<string, string> {
  return { ...obj, payload: b64encode(obj.payload) };
}

/** Rebuild in-memory objects, skipping any malformed record (fail closed). */
export function deserializeObjects(value: unknown): Record<string, PortalObject> {
  const objectsById: Record<string, PortalObject> = {};
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [id, raw] of Object.entries(value)) {
      try {
        objectsById[id] = parsePortalObjectReply(raw);
      } catch {
        // Malformed persisted object: skip it, keep the rest of the replica.
      }
    }
  }
  return objectsById;
}

/**
 * Validate a persisted author log with the same wire assertions as
 * `parsePortalLogReply`. Returns `null` (fail closed) if any entry is
 * malformed, out of order, or authored by someone else — a corrupted or
 * hand-edited replica must not seed continuity checks.
 */
export function parsePersistedEntries(key: string, value: unknown): PortalLogEntry[] | null {
  if (!Array.isArray(value)) return null;
  const root = key as unknown;
  const author = hexSize(root, 32, 'author key');
  const entries: PortalLogEntry[] = [];
  let prev = -1;
  for (const item of value) {
    try {
      if (item === null || typeof item !== 'object') return null;
      const raw = item as { author?: unknown; seq?: unknown; objId?: unknown; sig?: unknown };
      const entryAuthor = hexSize(raw.author, 32, 'entry author');
      const objId = hexSize(raw.objId, 32, 'entry objId');
      const sig = hexSize(raw.sig, 64, 'entry sig');
      const seq = uintSeq(raw.seq, 'entry seq');
      if (entryAuthor !== author || seq <= prev) return null;
      prev = seq;
      entries.push({ author: entryAuthor, seq, objId: objId, sig });
    } catch {
      return null;
    }
  }
  return entries;
}

/** Drop smallest-author logs first until the object cap is met. */
export function trimReplica(replica: PortalReplica, maxObjects = MAX_KEPT_OBJECTS): PortalReplica {
  let objects = replica.objectsById;
  let entriesByAuthor = replica.entriesByAuthor;
  if (Object.keys(objects).length <= maxObjects) return { entriesByAuthor, objectsById: objects };
  const authors = Object.keys(entriesByAuthor).sort(
    (a, b) => (entriesByAuthor[a]?.length ?? 0) - (entriesByAuthor[b]?.length ?? 0),
  );
  while (Object.keys(objects).length > maxObjects && authors.length > 1) {
    const dropped = authors.shift() as string;
    const removed = entriesByAuthor[dropped] ?? [];
    entriesByAuthor = { ...entriesByAuthor };
    delete entriesByAuthor[dropped];
    const stillNeeded = new Set<string>();
    for (const list of Object.values(entriesByAuthor)) {
      for (const e of list) stillNeeded.add(e.objId);
    }
    objects = { ...objects };
    for (const id of removed.map((e) => e.objId)) {
      if (!stillNeeded.has(id)) delete objects[id];
    }
  }
  return { entriesByAuthor, objectsById: objects };
}

/**
 * One friendly line for the sync status under the portal panel.
 * Mirrors `describeSync` in `./sync.ts` (deliberate parity: both are pure,
 * tested, and tensor-free — folding them into a shared helper would read as
 * over-clever for a three-clause status string).
 */
export function describePortalSync(
  now: number,
  status: PortalSyncStatus,
): { text: string; tone: 'ok' | 'busy' | 'bad' | 'idle' } {
  if (status.syncing) return { text: 'Syncing… fetching heads, logs, and objects.', tone: 'busy' };
  if (status.error) return { text: `Couldn't sync the portal replica. ${status.error}`, tone: 'bad' };
  if (status.lastSyncedAt === null) return { text: 'No portal sync yet.', tone: 'idle' };
  const ageMs = Math.max(0, now - status.lastSyncedAt);
  if (ageMs < 15_000) return { text: 'Portal up to date — checked just now.', tone: 'ok' };
  if (ageMs < 60_000) return { text: `Portal up to date — checked ${Math.floor(ageMs / 1000)}s ago.`, tone: 'ok' };
  return { text: `Portal checked ${Math.floor(ageMs / 60_000)}m ago.`, tone: 'ok' };
}
