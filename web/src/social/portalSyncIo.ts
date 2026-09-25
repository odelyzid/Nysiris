/**
 * Sync driver: pulls a portal replica over the mixnet.
 *
 * One `syncPortalReplica(address, prev)` call runs the whole read-side
 * gossip against `services/portal-provider`:
 *
 *   1. `GET /heads`                              (serialized `fetchNym`)
 *   2. per-author `GET /log/<author>?since=<our hold>`  (parallel, tag-echoed)
 *   3. per-author `GET /obj/<id>` for everything new   (parallel)
 *
 * Every author is applied atomically: if her entries break continuity, fail
 * signature check, or reference an object that won't verify, she is flagged
 * in `summary.failed` and nothing of hers lands. Forks are never merged.
 *
 * This module talks to the tunnel, so it is not imported by `node --test`
 * (the pure protocol lives in `./portalSync.ts` and is covered there).
 */
import { fetchNym, fetchNymParallel, type FetchNymResponse } from '../mixnet/fetchNym';
import {
  defaultPortalSyncStorage,
  diffPortalWants,
  mergePortalEntries,
  parsePortalHeadsReply,
  parsePortalLogReply,
  parsePortalObjectReply,
  portalHeads,
  savePortalReplica,
  verifyPortalObjectId,
  type PortalLogEntry,
  type PortalObject,
  type PortalReplica,
  type PortalStorage,
  type PortalWant,
} from './portalSync';
import { verifyLogEntrySig, verifyObjectSig } from './portalVerify';

export interface PortalSyncSummary {
  /** Authors whose log advanced this run. */
  authors: number;
  /** Log entries accepted this run. */
  entries: number;
  /** Objects verified + stored this run. */
  objects: number;
  /** Heads the peer advertised (author → seq), before local filtering. */
  heads: Record<string, number>;
  /** Authors whose batch was rejected (equivalent beacon for reputation). */
  failed: string[];
}

export interface PortalSyncOptions {
  /** SURB-reply wait per batch. Default 90 s (mixnet latency). */
  timeoutMs?: number;
  /** Where to persist the refreshed replica. Defaults to localStorage. */
  storage?: PortalStorage | null;
  /** Resolve a Nym address for probe links (default: live mixnet). */
  fetch?: typeof fetchNym;
  parallel?: typeof fetchNymParallel;
}

/** Decode a fetch response body as JSON, failing closed on transport errors. */
function bodyJson(res: FetchNymResponse, what: string): unknown {
  if (res.error) throw new Error(`${what}: ${res.error}`);
  if (res.status !== 200) throw new Error(`${what}: HTTP ${res.status}`);
  try {
    return JSON.parse(new TextDecoder().decode(res.body));
  } catch {
    throw new Error(`${what}: invalid JSON body`);
  }
}

export async function syncPortalReplica(
  address: string,
  prev: PortalReplica,
  options?: PortalSyncOptions,
): Promise<{ replica: PortalReplica; summary: PortalSyncSummary }> {
  const timeoutMs = options?.timeoutMs ?? 90_000;
  const fetch = options?.fetch ?? fetchNym;
  const parallel = options?.parallel ?? fetchNymParallel;
  const storage = options?.storage !== undefined ? options.storage : defaultPortalSyncStorage();

  const headsRes = await fetch(address, { method: 'GET', path: '/heads' }, { timeoutMs });
  const peer = parsePortalHeadsReply(bodyJson(headsRes, 'heads'));
  const summary: PortalSyncSummary = {
    authors: 0,
    entries: 0,
    objects: 0,
    heads: peer,
    failed: [],
  };

  const wants = diffPortalWants(portalHeads(prev), peer);
  if (wants.length === 0) {
    prev = { ...prev, objectsById: { ...prev.objectsById } };
    return { replica: prev, summary };
  }

  const resolved = new Map<string, PortalWant>();
  const parsedEntries = new Map<string, PortalLogEntry[]>();
  try {
    const logResps = await parallel(
      address,
      wants.map((w) => ({ method: 'GET', path: `/log/${w.author}?since=${w.fromSeq}` })),
      { timeoutMs },
    );
    for (let i = 0; i < wants.length; i += 1) {
      const want = wants[i];
      try {
        const { entries } = parsePortalLogReply(bodyJson(logResps[i], `log ${want.author}`), want.fromSeq);
        resolved.set(want.author, want);
        parsedEntries.set(want.author, entries);
      } catch {
        failedAdd(summary, want.author);
      }
    }
  } catch {
    for (const want of wants) failedAdd(summary, want.author);
  }

  const objectsById = { ...prev.objectsById };
  for (const author of resolved.keys()) {
    const entries = parsedEntries.get(author) as PortalLogEntry[];
    const missing = [...new Set(entries.map((e) => e.objId).filter((id) => !(id in objectsById)))];
    const fetched = new Map<string, PortalObject>();
    if (missing.length > 0) {
      try {
        const objResps = await parallel(
          address,
          missing.map((id) => ({ method: 'GET', path: `/obj/${id}` })),
          { timeoutMs },
        );
        for (let i = 0; i < missing.length; i += 1) {
          const id = missing[i];
          const obj = parsePortalObjectReply(bodyJson(objResps[i], `obj ${id}`));
          if (obj.id !== id) throw new Error(`obj ${id}: reply claims ${obj.id}`);
          if (!(await verifyPortalObjectId(obj))) throw new Error(`obj ${id}: id does not match content`);
          if (!verifyObjectSig(obj)) throw new Error(`obj ${id}: bad signature`);
          fetched.set(id, obj);
        }
      } catch {
        failedAdd(summary, author);
        continue;
      }
    }
    try {
      const { replica: next, applied } = await mergePortalEntries(prev, entries, verifyLogEntrySig);
      prev = next;
      for (const [id, obj] of fetched) objectsById[id] = obj;
      summary.authors += 1;
      summary.entries += applied;
      summary.objects += fetched.size;
    } catch {
      failedAdd(summary, author);
    }
  }

  const replica: PortalReplica = { ...prev, objectsById };
  savePortalReplica(replica, storage);
  return { replica, summary };
}

function failedAdd(summary: PortalSyncSummary, author: string): void {
  if (!summary.failed.includes(author)) summary.failed.push(author);
}