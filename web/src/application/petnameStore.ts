/**
 * Persistence for local petnames (localStorage).
 *
 * Pure label rules live in `../domain/petnames`; this module owns the
 * `fly.social.petnames` slot and re-exports the domain so callers keep one
 * entry point.
 */
export * from '../domain/petnames.ts';

import { normalizeAuthor } from '../lib/address.ts';
import { defaultStorage } from '../lib/storage.ts';
import { cleanPetname } from '../domain/petnames.ts';

export interface PetnameStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'fly.social.petnames';

/** Petnames by author pubkey hex. Unknown/malformed entries dropped. */
export function loadPetnames(storage?: PetnameStorage | null): Record<string, string> {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [author, name] of Object.entries(parsed as Record<string, unknown>)) {
      const key = normalizeAuthor(author);
      const clean = cleanPetname(name);
      if (key && clean) out[key] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

export function savePetnames(petnames: Record<string, string>, storage?: PetnameStorage | null): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(petnames));
  } catch {
    // Private mode: petnames just don't persist.
  }
}

/** `localStorage` when it exists, otherwise null (SSR/tests/workers). */
export function defaultPetnameStorage(): PetnameStorage | null {
  return defaultStorage();
}
