/**
 * Shared localStorage guard: returns `localStorage` when it exists, else
 * null (SSR/tests/workers). Every persistence module uses this via its own
 * `defaultXStorage()` factory so call sites stay browser-global-free.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `localStorage` when present, otherwise null (never throws). */
export function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}
