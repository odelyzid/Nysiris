/**
 * Bookmarks: named private links saved on this device. Pure logic + injected
 * storage (same pattern as `contacts.ts` / `views.ts`), unit-testable with
 * `node --test web/test`. Nothing here ever touches the network, by
 * construction.
 */

import { defaultStorage } from '../lib/storage.ts';

export interface Bookmark {
  /** User-chosen label, normalized (trimmed, collapsed, lower-cased). */
  name: string;
  /** The private link or Nym address to reopen. */
  link: string;
  addedAt: number;
}

export interface BookmarkStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'fly.bookmarks';

/** How many bookmarks this device keeps. */
export const MAX_BOOKMARKS = 50;

/** Normalized name used for storage + dedupe (trim, collapse spaces, lower-case). */
export function normalizeBookmarkName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Saved bookmarks, newest first. Unknown/garbage shapes dropped. */
export function loadBookmarks(storage?: BookmarkStorage | null): Bookmark[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b): b is Bookmark =>
        typeof b === 'object' &&
        b !== null &&
        typeof (b as Bookmark).name === 'string' &&
        typeof (b as Bookmark).link === 'string' &&
        (b as Bookmark).name.trim().length > 0 &&
        (b as Bookmark).link.trim().length > 0,
    );
  } catch {
    return [];
  }
}

export function saveBookmarks(bookmarks: Bookmark[], storage?: BookmarkStorage | null): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(bookmarks.slice(0, MAX_BOOKMARKS)));
  } catch {
    // Private mode / quota: bookmarks just don't persist.
  }
}

/**
 * Add a bookmark, deduped by normalized name (newest first, capped). Always
 * returns a fresh array — the caller may compare lengths to detect a no-op
 * duplicate (a bookmark with that name already exists). Never mutates input.
 */
export function addBookmark(
  bookmarks: Bookmark[],
  bookmark: { name: string; link: string; addedAt?: number },
): Bookmark[] {
  const name = normalizeBookmarkName(bookmark.name);
  const link = bookmark.link.trim();
  if (!name || !link) return [...bookmarks];
  if (bookmarks.some((b) => b.name === name)) return [...bookmarks];
  return [{ name, link, addedAt: bookmark.addedAt ?? Date.now() }, ...bookmarks].slice(0, MAX_BOOKMARKS);
}

/** Remove the bookmark with this (normalized) name. Never mutates the input. */
export function removeBookmark(bookmarks: Bookmark[], name: string): Bookmark[] {
  const key = normalizeBookmarkName(name);
  return bookmarks.filter((b) => b.name !== key);
}

/** Whether `link` is already bookmarked (trim-compared, empty never matches). */
export function isBookmarked(bookmarks: Bookmark[], link: string): boolean {
  const clean = link.trim();
  return clean.length > 0 && bookmarks.some((b) => b.link === clean);
}

export function defaultBookmarkStorage(): BookmarkStorage | null {
  return defaultStorage();
}
