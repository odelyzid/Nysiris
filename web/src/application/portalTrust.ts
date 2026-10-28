/**
 * Per-portal trust and local reputation isolation.
 *
 * A verdict in portal A never applies to portal B, and neither is shared with
 * the social trust store. Values are first-hand local decisions only.
 */
import type { StorageLike } from '../lib/storage.ts';

export type PortalVerdict = 'trusted' | 'neutral' | 'blocked';
export type PortalAuthorTrust = Partial<Record<'trusted' | 'blocked', number>>;

export const PORTAL_TRUST_KEY = 'fly.portal.trust.v1';
export const MAX_TRUST_SCOPES = 64;
export const MAX_TRUST_AUTHORS = 512;

interface StoredTrust {
  version: 1;
  scopes: Record<string, Record<string, PortalVerdict>>;
}

export class PortalTrustStore {
  private readonly scopes = new Map<string, Map<string, PortalVerdict>>();

  constructor(initial: Record<string, Record<string, PortalVerdict>> = {}) {
    for (const [scope, authors] of Object.entries(initial).slice(0, MAX_TRUST_SCOPES)) {
      if (!scope || !authors || typeof authors !== 'object') continue;
      const clean = new Map<string, PortalVerdict>();
      for (const [author, verdict] of Object.entries(authors).slice(0, MAX_TRUST_AUTHORS)) {
        if (/^[0-9a-f]{64}$/i.test(author) && isVerdict(verdict)) clean.set(author.toLowerCase(), verdict);
      }
      this.scopes.set(scope, clean);
    }
  }

  get(scope: string, author: string): PortalVerdict {
    return this.scopes.get(normaliseScope(scope))?.get(normaliseAuthor(author)) ?? 'neutral';
  }

  set(scope: string, author: string, verdict: PortalVerdict | null): void {
    const cleanScope = normaliseScope(scope);
    const cleanAuthor = normaliseAuthor(author);
    if (!cleanScope || !cleanAuthor) return;
    const authors = this.scopes.get(cleanScope) ?? new Map<string, PortalVerdict>();
    if (verdict === null || verdict === 'neutral') authors.delete(cleanAuthor);
    else if (isVerdict(verdict)) authors.set(cleanAuthor, verdict);
    if (authors.size === 0) this.scopes.delete(cleanScope);
    else {
      this.scopes.delete(cleanScope);
      this.scopes.set(cleanScope, authors);
    }
    while (this.scopes.size > MAX_TRUST_SCOPES) {
      const oldest = this.scopes.keys().next().value;
      if (oldest === undefined) break;
      this.scopes.delete(oldest);
    }
  }

  isTrusted(scope: string, author: string): boolean {
    return this.get(scope, author) === 'trusted';
  }

  isBlocked(scope: string, author: string): boolean {
    return this.get(scope, author) === 'blocked';
  }

  /** Authors to show in a trusted-only view; empty means "not configured". */
  trustedAuthors(scope: string): string[] {
    const authors = this.scopes.get(normaliseScope(scope));
    if (!authors) return [];
    return [...authors.entries()].filter(([, verdict]) => verdict === 'trusted').map(([author]) => author);
  }

  clear(scope?: string): void {
    if (scope === undefined) {
      this.scopes.clear();
      return;
    }
    this.scopes.delete(normaliseScope(scope));
  }

  toJSON(): Record<string, Record<string, PortalVerdict>> {
    return Object.fromEntries(
      [...this.scopes].map(([scope, authors]) => [scope, Object.fromEntries(authors.entries())]),
    );
  }

  get size(): number {
    return this.scopes.size;
  }
}

export function loadPortalTrust(storage: StorageLike | null): PortalTrustStore {
  try {
    const raw = storage?.getItem(PORTAL_TRUST_KEY);
    if (!raw) return new PortalTrustStore();
    const parsed = JSON.parse(raw) as Partial<StoredTrust>;
    if (parsed?.version !== 1 || !parsed.scopes || typeof parsed.scopes !== 'object') {
      return new PortalTrustStore();
    }
    return new PortalTrustStore(parsed.scopes as Record<string, Record<string, PortalVerdict>>);
  } catch {
    return new PortalTrustStore();
  }
}

export function savePortalTrust(storage: StorageLike | null, store: PortalTrustStore): void {
  try {
    storage?.setItem(PORTAL_TRUST_KEY, JSON.stringify({ version: 1, scopes: store.toJSON() } satisfies StoredTrust));
  } catch {
    // Private mode/quota.
  }
}

function normaliseScope(scope: string): string {
  return String(scope ?? '')
    .trim()
    .slice(0, 512);
}

function normaliseAuthor(author: string): string {
  return /^[0-9a-f]{64}$/i.test(String(author ?? '')) ? String(author).toLowerCase() : '';
}

function isVerdict(value: unknown): value is PortalVerdict {
  return value === 'trusted' || value === 'neutral' || value === 'blocked';
}
