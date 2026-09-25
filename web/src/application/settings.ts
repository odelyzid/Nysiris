/**
 * Small user-preference settings for the community timeline.
 *
 * Pure logic (no browser globals): storage is injected, matching the
 * pattern in `conversations.ts` / `views.ts`. The bool encoding (`'1'` /
 * `'0'`) is preserved — renaming the key or value format would reset the
 * toggle for existing users.
 */
import { defaultStorage } from '../lib/storage.ts';
export interface BooleanStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const TRUSTED_ONLY_KEY = 'fly.social.trustedOnly';

/** Read the timeline-scope toggle; any storage failure means "everyone". */
export function loadTrustedOnly(storage: BooleanStore | null): boolean {
  try {
    return storage?.getItem(TRUSTED_ONLY_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist the timeline-scope toggle; non-fatal when storage is unavailable. */
export function saveTrustedOnly(value: boolean, storage: BooleanStore | null): void {
  try {
    storage?.setItem(TRUSTED_ONLY_KEY, value ? '1' : '0');
  } catch {
    // Private mode: scope just doesn't persist.
  }
}

/** localStorage in browsers, null elsewhere. */
export function defaultBooleanStorage(): BooleanStore | null {
  return defaultStorage();
}
