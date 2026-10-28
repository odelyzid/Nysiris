/**
 * Offline media cache for portal/read-later content.
 *
 * Range streaming keeps memory bounded, but the user can explicitly save a
 * media/PDF document for offline reading. Bytes live in IndexedDB keyed by the
 * canonical URL; a memory fallback keeps tests/private mode functional. The
 * media element then uses a blob URL without touching the mixnet.
 */
import { transferRanges, type RangeFetcher } from './downloadTransfer.ts';

export const PORTAL_MEDIA_DB = 'nysiris-portal-media';
export const PORTAL_MEDIA_STORE = 'media';

export interface CachedMedia {
  url: string;
  contentType: string;
  bytes: Uint8Array;
  cachedAt: number;
}

export interface MediaCacheStore {
  load(url: string): Promise<CachedMedia | null>;
  save(media: CachedMedia): Promise<void>;
  clear(url: string): Promise<void>;
}

export class MemoryMediaCache implements MediaCacheStore {
  private readonly entries = new Map<string, CachedMedia>();

  async load(url: string): Promise<CachedMedia | null> {
    return this.entries.get(url) ?? null;
  }

  async save(media: CachedMedia): Promise<void> {
    this.entries.set(media.url, media);
  }

  async clear(url: string): Promise<void> {
    this.entries.delete(url);
  }
}

export class IndexedDbMediaCache implements MediaCacheStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly dbName: string;
  private readonly storeName: string;

  constructor(dbName = PORTAL_MEDIA_DB, storeName = PORTAL_MEDIA_STORE) {
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
        if (!request.result.objectStoreNames.contains(this.storeName)) {
          request.result.createObjectStore(this.storeName, { keyPath: 'url' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('could not open media cache'));
    });
    return this.dbPromise;
  }

  async load(url: string): Promise<CachedMedia | null> {
    try {
      const db = await this.open();
      const row = await new Promise<{
        url?: unknown;
        contentType?: unknown;
        data?: unknown;
        cachedAt?: unknown;
      } | null>((resolve, reject) => {
        const request = db.transaction(this.storeName, 'readonly').objectStore(this.storeName).get(url);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
      if (!row || typeof row.url !== 'string' || !(row.data instanceof ArrayBuffer)) return null;
      return {
        url: row.url,
        contentType: typeof row.contentType === 'string' ? row.contentType : 'application/octet-stream',
        bytes: new Uint8Array(row.data.slice(0)),
        cachedAt: typeof row.cachedAt === 'number' ? row.cachedAt : 0,
      };
    } catch {
      return null;
    }
  }

  async save(media: CachedMedia): Promise<void> {
    try {
      const db = await this.open();
      const copy = new Uint8Array(media.bytes.length);
      copy.set(media.bytes);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).put({
          url: media.url,
          contentType: media.contentType,
          data: copy.buffer,
          cachedAt: media.cachedAt,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Quota/private mode: keep the in-memory copy only.
    }
  }

  async clear(url: string): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).delete(url);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Nothing to clear.
    }
  }
}

let sharedCache: MediaCacheStore | null = null;

export function defaultMediaCache(): MediaCacheStore {
  if (!sharedCache) {
    try {
      sharedCache = typeof indexedDB !== 'undefined' ? new IndexedDbMediaCache() : new MemoryMediaCache();
    } catch {
      sharedCache = new MemoryMediaCache();
    }
  }
  return sharedCache;
}

/** Download a whole document through the range fetcher and cache it. */
export async function downloadMediaToCache(
  fetcher: RangeFetcher,
  store: MediaCacheStore,
  url: string,
  contentType: string,
  total: number | null,
  signal?: AbortSignal,
): Promise<CachedMedia> {
  const result = await transferRanges(fetcher, {
    total,
    maxBytes: 32 * 1024 * 1024,
    signal,
  });
  const media: CachedMedia = {
    url,
    contentType,
    bytes: result.bytes,
    cachedAt: Date.now(),
  };
  await store.save(media);
  return media;
}

export function mediaBlobUrl(media: CachedMedia): string {
  const copy = new Uint8Array(media.bytes.length);
  copy.set(media.bytes);
  return URL.createObjectURL(new Blob([copy.buffer], { type: media.contentType || 'application/octet-stream' }));
}
