/**
 * Per-portal replica storage.
 *
 * Metadata (which workspaces exist, last sync, object counts) stays in
 * localStorage for cheap startup; actual signed logs/objects live in IndexedDB
 * so a portal can grow past the ~5 MB localStorage budget. A localStorage
 * fallback keeps tests, private mode, and old WebViews working.
 */
import { defaultStorage } from '../lib/storage.ts';
import type { StorageLike } from '../lib/storage.ts';
import {
  deserializeObjects,
  parsePersistedEntries,
  serializeObject,
  trimReplica,
  type PortalObject,
  type PortalReplica,
} from '../domain/portalSync.ts';

export { emptyReplica } from '../domain/portalSync.ts';

export const PORTAL_META_KEY = 'fly.portal.meta.v1';
export const PORTAL_REPLICA_PREFIX = 'fly.portal.replica.v2.';
export const PORTAL_DB_NAME = 'nysiris-portal';
export const PORTAL_DB_STORE = 'replicas';
export const MAX_PORTAL_META = 64;

export interface PortalReplicaMetadata {
  scope: string;
  updatedAt: number;
  authors: number;
  entries: number;
  objects: number;
}

interface StoredReplica {
  scope: string;
  updatedAt: number;
  entriesByAuthor: unknown;
  objectsById: unknown;
}

export interface PortalReplicaStore {
  load(scope: string): Promise<PortalReplica | null>;
  save(scope: string, replica: PortalReplica): Promise<void>;
  clear(scope: string): Promise<void>;
}

export class MemoryPortalStore implements PortalReplicaStore {
  private readonly replicas = new Map<string, PortalReplica>();

  async load(scope: string): Promise<PortalReplica | null> {
    return this.replicas.get(scope) ?? null;
  }

  async save(scope: string, replica: PortalReplica): Promise<void> {
    this.replicas.set(scope, replica);
  }

  async clear(scope: string): Promise<void> {
    this.replicas.delete(scope);
  }
}

export class LocalStoragePortalStore implements PortalReplicaStore {
  private readonly storage: StorageLike | null;

  constructor(storage: StorageLike | null = defaultStorage()) {
    this.storage = storage;
  }

  async load(scope: string): Promise<PortalReplica | null> {
    try {
      const raw = this.storage?.getItem(PORTAL_REPLICA_PREFIX + encodeURIComponent(scope));
      if (!raw) return null;
      return deserializeReplica(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async save(scope: string, replica: PortalReplica): Promise<void> {
    try {
      const trimmed = trimReplica(replica);
      this.storage?.setItem(
        PORTAL_REPLICA_PREFIX + encodeURIComponent(scope),
        JSON.stringify({
          scope,
          updatedAt: Date.now(),
          entriesByAuthor: trimmed.entriesByAuthor,
          objectsById: serializeObjects(trimmed.objectsById),
        } satisfies StoredReplica),
      );
    } catch {
      // Quota/private mode: the replica is memory-only this session.
    }
  }

  async clear(scope: string): Promise<void> {
    try {
      this.storage?.setItem(PORTAL_REPLICA_PREFIX + encodeURIComponent(scope), '');
    } catch {
      // Nothing to clear.
    }
  }
}

export class IndexedDbPortalStore implements PortalReplicaStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly dbName: string;
  private readonly storeName: string;

  constructor(dbName = PORTAL_DB_NAME, storeName = PORTAL_DB_STORE) {
    this.dbName = dbName;
    this.storeName = storeName;
  }

  private open(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName, { keyPath: 'scope' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('could not open portal store'));
    });
    return this.dbPromise;
  }

  async load(scope: string): Promise<PortalReplica | null> {
    try {
      const db = await this.open();
      const raw = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readonly');
        const request = tx.objectStore(this.storeName).get(scope);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return deserializeReplica(raw);
    } catch {
      return null;
    }
  }

  async save(scope: string, replica: PortalReplica): Promise<void> {
    try {
      const db = await this.open();
      const trimmed = trimReplica(replica);
      const record: StoredReplica = {
        scope,
        updatedAt: Date.now(),
        entriesByAuthor: trimmed.entriesByAuthor,
        objectsById: serializeObjects(trimmed.objectsById),
      };
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Private mode/quota: caller keeps the in-memory replica.
    }
  }

  async clear(scope: string): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).delete(scope);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Nothing to clear.
    }
  }
}

export function defaultPortalContentStore(storage: StorageLike | null = defaultStorage()): PortalReplicaStore {
  try {
    if (typeof indexedDB !== 'undefined') return new IndexedDbPortalStore();
  } catch {
    // Fall through to localStorage.
  }
  return new LocalStoragePortalStore(storage);
}

/** Persist a replica and refresh its metadata slot. */
export async function saveScopedReplica(
  store: PortalReplicaStore,
  scope: string,
  replica: PortalReplica,
  storage: StorageLike | null = defaultStorage(),
): Promise<void> {
  await store.save(scope, replica);
  savePortalMeta(storage, replicaMeta(scope, replica));
}

export async function loadScopedReplica(store: PortalReplicaStore, scope: string): Promise<PortalReplica | null> {
  return store.load(scope);
}

export function replicaMeta(scope: string, replica: PortalReplica): PortalReplicaMetadata {
  return {
    scope,
    updatedAt: Date.now(),
    authors: Object.keys(replica.entriesByAuthor).length,
    entries: Object.values(replica.entriesByAuthor).reduce((sum, entries) => sum + entries.length, 0),
    objects: Object.keys(replica.objectsById).length,
  };
}

export function loadPortalMeta(storage: StorageLike | null = defaultStorage()): PortalReplicaMetadata[] {
  try {
    const raw = storage?.getItem(PORTAL_META_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PortalReplicaMetadata[] = [];
    const seen = new Set<string>();
    for (const item of parsed.slice(0, MAX_PORTAL_META)) {
      if (!item || typeof item !== 'object') continue;
      const meta = item as Partial<PortalReplicaMetadata>;
      if (typeof meta.scope !== 'string' || !meta.scope || seen.has(meta.scope)) continue;
      seen.add(meta.scope);
      out.push({
        scope: meta.scope,
        updatedAt: typeof meta.updatedAt === 'number' && Number.isFinite(meta.updatedAt) ? meta.updatedAt : 0,
        authors: count(meta.authors),
        entries: count(meta.entries),
        objects: count(meta.objects),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function savePortalMeta(storage: StorageLike | null, meta: PortalReplicaMetadata): void {
  try {
    const next = [meta, ...loadPortalMeta(storage).filter((item) => item.scope !== meta.scope)].slice(
      0,
      MAX_PORTAL_META,
    );
    storage?.setItem(PORTAL_META_KEY, JSON.stringify(next));
  } catch {
    // Metadata is advisory; the replica store remains authoritative.
  }
}

export function clearPortalMeta(storage: StorageLike | null, scope: string): void {
  try {
    storage?.setItem(PORTAL_META_KEY, JSON.stringify(loadPortalMeta(storage).filter((item) => item.scope !== scope)));
  } catch {
    // Nothing to clear.
  }
}

function deserializeReplica(raw: unknown): PortalReplica | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const stored = raw as Partial<StoredReplica>;
  if (!stored.entriesByAuthor || typeof stored.entriesByAuthor !== 'object') return null;
  const entriesByAuthor: PortalReplica['entriesByAuthor'] = {};
  for (const [author, entries] of Object.entries(stored.entriesByAuthor as Record<string, unknown>)) {
    const parsed = parsePersistedEntries(author, entries);
    if (parsed !== null) entriesByAuthor[author] = parsed;
  }
  return { entriesByAuthor, objectsById: deserializeObjects(stored.objectsById) };
}

function serializeObjects(objects: Record<string, PortalObject>): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(objects).map(([id, object]) => [id, serializeObject(object)]));
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
