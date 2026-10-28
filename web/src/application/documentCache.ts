/**
 * Small LRU cache for prepared pages.
 *
 * Back/forward and tab switching should not re-fetch a page over the mixnet.
 * This cache stores the *prepared* body (already sanitised/inlined), status,
 * and favicon. It is memory-only: persistence still stores URLs/history only.
 *
 * Pure and injectable so `node --test web/test` covers eviction and limits.
 */
import type { EmbeddedDocument } from './embeddedDocuments.ts';

export interface CachedPage {
  status: number;
  contentType: string;
  body: string;
  favicon: string | null;
  savedAt: number;
  /** Extracted object/embed documents, preserved with the prepared body. */
  embedded?: EmbeddedDocument[];
  /** Media/PDF stream descriptor when the page was rendered without a body. */
  mediaUrl?: string;
  mediaTotal?: number | null;
  mediaEtag?: string | null;
  /** Validators from the response that produced this body. */
  etag?: string | null;
  lastModified?: string | null;
  /** Final URL after redirects (relative assets were inlined already). */
  finalUrl?: string;
}

export const DEFAULT_MAX_CACHE_ENTRIES = 24;
export const DEFAULT_MAX_CACHE_BYTES = 16 * 1024 * 1024;

export class DocumentCache {
  private readonly entries = new Map<string, CachedPage>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;

  constructor(options: { maxEntries?: number; maxBytes?: number; now?: () => number } = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES);
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_CACHE_BYTES);
    this.now = options.now ?? (() => Date.now());
  }

  private readonly now: () => number;

  get(url: string): CachedPage | null {
    const page = this.entries.get(url);
    if (!page) return null;
    // Refresh LRU position.
    this.entries.delete(url);
    this.entries.set(url, page);
    return page;
  }

  set(url: string, page: Omit<CachedPage, 'savedAt'>): void {
    const size = pageSize({ ...page, savedAt: 0 });
    if (!url || size > this.maxBytes) return;
    const previous = this.entries.get(url);
    if (previous) {
      this.bytes -= pageSize(previous);
      this.entries.delete(url);
    }
    this.entries.set(url, { ...page, savedAt: this.now() });
    this.bytes += size;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (evicted) this.bytes -= pageSize(evicted);
    }
  }

  delete(url: string): void {
    const page = this.entries.get(url);
    if (!page) return;
    this.bytes -= pageSize(page);
    this.entries.delete(url);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get byteSize(): number {
    return this.bytes;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }
}

function pageSize(page: CachedPage): number {
  return page.body.length + (page.favicon?.length ?? 0) + 64;
}
