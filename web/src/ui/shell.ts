/**
 * Desktop-shell persistence: recent portals, context-panel visibility, and
 * the active DM thread. Pure logic + injected storage (same pattern as
 * `views.ts`), unit-testable with `node --test web/test`.
 */

import type { ViewStorage } from './views';

const PORTALS_KEY = 'fly.portals.recent';
const CONTEXT_KEY = 'fly.shell.context';
const THREAD_KEY = 'fly.messages.activeThread';

/** How many recently opened portals the roster remembers. */
export const MAX_RECENT_PORTALS = 8;

/** Portals opened via the URI bar, newest first. Unknown shapes dropped. */
export function loadRecentPortals(storage?: ViewStorage | null): string[] {
  try {
    const raw = storage?.getItem(PORTALS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  } catch {
    return [];
  }
}

export function saveRecentPortals(portals: string[], storage?: ViewStorage | null): void {
  try {
    storage?.setItem(PORTALS_KEY, JSON.stringify(portals.slice(0, MAX_RECENT_PORTALS)));
  } catch {
    // Private mode: recents just don't persist.
  }
}

/** Move `address` to the front, deduplicated, capped. Never mutates input. */
export function rememberPortal(portals: string[], address: string): string[] {
  const clean = address.trim();
  if (!clean) return [...portals];
  return [clean, ...portals.filter((p) => p !== clean)].slice(0, MAX_RECENT_PORTALS);
}

/** Context panel starts open; explicit close persists. */
export function loadContextOpen(storage?: ViewStorage | null): boolean {
  try {
    return storage?.getItem(CONTEXT_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveContextOpen(open: boolean, storage?: ViewStorage | null): void {
  try {
    storage?.setItem(CONTEXT_KEY, open ? '1' : '0');
  } catch {
    // Private mode: the panel just resets to open next load.
  }
}

/** Which DM thread was open last time (validated by the caller against live threads). */
export function loadActiveThread(storage?: ViewStorage | null): string | null {
  try {
    const raw = storage?.getItem(THREAD_KEY);
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function saveActiveThread(key: string | null, storage?: ViewStorage | null): void {
  try {
    if (key) storage?.setItem(THREAD_KEY, key);
  } catch {
    // Private mode: the thread just resets next load.
  }
}
