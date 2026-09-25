/**
 * Persistence for explicit trust verdicts (localStorage).
 *
 * Pure display/decision logic lives in `../domain/trust`; this module owns the
 * `fly.social.trust` slot and re-exports the domain so callers keep one entry
 * point.
 */
export * from '../domain/trust.ts';

import { normalizeAuthor } from '../lib/address.ts';
import { defaultStorage } from '../lib/storage.ts';
import type { Verdict } from '../domain/trust.ts';

export interface TrustStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'fly.social.trust';

/** Explicit verdicts by author pubkey hex. Unknown/malformed entries dropped. */
export function loadTrust(storage?: TrustStorage | null): Record<string, Verdict> {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, Verdict> = {};
    for (const [author, verdict] of Object.entries(parsed as Record<string, unknown>)) {
      const key = normalizeAuthor(author);
      if (key && (verdict === 'trusted' || verdict === 'blocked')) out[key] = verdict;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveTrust(verdicts: Record<string, Verdict>, storage?: TrustStorage | null): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(verdicts));
  } catch {
    // Private mode: verdicts just don't persist.
  }
}

/** `localStorage` when it exists, otherwise null (SSR/tests/workers). */
export function defaultTrustStorage(): TrustStorage | null {
  return defaultStorage();
}
