/**
 * Per-URL scroll positions for the in-app document viewer.
 *
 * A browser restores scroll when you go back/forward or reopen a page. The
 * iframe itself does not persist anything, so the app records the position by
 * canonical URL and restores it on load. This is intentionally separate from
 * the tab model: writing to React state on every scroll event is wasteful.
 */
import type { StorageLike } from '../lib/storage.ts';

export const SCROLL_KEY = 'fly.browser.scroll.v1';
export const MAX_SCROLL_ENTRIES = 200;

export function loadScrollPositions(storage: StorageLike | null): Record<string, number> {
  try {
    const raw = storage?.getItem(SCROLL_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    let count = 0;
    for (const [url, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
      if (!/^(nym:\/\/|https?:\/\/)/i.test(url)) continue;
      out[url] = Math.floor(value);
      count += 1;
      if (count >= MAX_SCROLL_ENTRIES) break;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveScrollPositions(storage: StorageLike | null, positions: Record<string, number>): void {
  try {
    const entries = Object.entries(positions)
      .filter(([url, value]) => /^(nym:\/\/|https?:\/\/)/i.test(url) && Number.isFinite(value))
      .slice(-MAX_SCROLL_ENTRIES);
    storage?.setItem(SCROLL_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Private mode/quota: scroll restoration just won't persist.
  }
}

/** Convenience for one position, preserving the rest. */
export function rememberScroll(storage: StorageLike | null, url: string, position: number): void {
  if (!url || !Number.isFinite(position)) return;
  const positions = loadScrollPositions(storage);
  delete positions[url];
  positions[url] = Math.max(0, Math.floor(position));
  saveScrollPositions(storage, positions);
}
