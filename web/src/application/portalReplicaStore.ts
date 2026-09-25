/**
 * Persistence for the portal replica (localStorage, `fly.portal.sync.v1`).
 *
 * The replication protocol and its pure parsers live in
 * `../domain/portalSync`; this module owns the storage slot and re-exports the
 * domain so callers keep one entry point.
 */
export * from '../domain/portalSync.ts';

import { defaultStorage } from '../lib/storage.ts';
import {
  PORTAL_SYNC_KEY,
  deserializeObjects,
  emptyReplica,
  parsePersistedEntries,
  serializeObject,
  trimReplica,
  type PortalLogEntry,
  type PortalObject,
  type PortalReplica,
} from '../domain/portalSync.ts';

export interface PortalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * `localStorage` when it exists, otherwise null (SSR/tests/workers).
 * Storage is injected everywhere else so the protocol stays importable offline.
 */
export function defaultPortalSyncStorage(): PortalStorage | null {
  return defaultStorage();
}

/**
 * Load a persisted replica under `PORTAL_SYNC_KEY`. Malformed, absent, or
 * corrupted data yields an empty replica — never a crash.
 */
export function loadPortalReplica(storage?: PortalStorage | null): PortalReplica {
  const fallback = emptyReplica();
  try {
    const raw = storage?.getItem(PORTAL_SYNC_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { entriesByAuthor?: unknown; objectsById?: unknown };
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    if (typeof parsed.entriesByAuthor !== 'object' || parsed.entriesByAuthor === null) return fallback;
    const entriesByAuthor: Record<string, PortalLogEntry[]> = {};
    for (const [author, log] of Object.entries(parsed.entriesByAuthor)) {
      const entries = parsePersistedEntries(author, log);
      if (entries !== null) entriesByAuthor[author] = entries;
    }
    return {
      entriesByAuthor,
      objectsById: deserializeObjects(parsed.objectsById),
    };
  } catch {
    return fallback;
  }
}

/**
 * Persist a replica, pruned to `MAX_KEPT_OBJECTS`. Quota failures are
 * swallowed (the replica just resets next load). Smallest logs drop first so
 * synced history is bounded, not lost.
 */
export function savePortalReplica(replica: PortalReplica, storage?: PortalStorage | null): void {
  try {
    const trimmed = trimReplica(replica);
    const objectsById: Record<string, Record<string, string>> = {};
    for (const [id, obj] of Object.entries(trimmed.objectsById)) objectsById[id] = serializeObject(obj);
    storage?.setItem(PORTAL_SYNC_KEY, JSON.stringify({ entriesByAuthor: trimmed.entriesByAuthor, objectsById }));
  } catch {
    // Private mode / quota: the replica just resets next load.
  }
}
