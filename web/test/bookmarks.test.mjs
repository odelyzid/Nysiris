// Run with: node --test web/test
// Verifies bookmarks storage + rules (web/src/application/bookmarks.ts):
// persistence round-trip, dedupe/ordering/caps, and graceful degradation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BOOKMARKS,
  addBookmark,
  defaultBookmarkStorage,
  isBookmarked,
  loadBookmarks,
  normalizeBookmarkName,
  removeBookmark,
  saveBookmarks,
} from '../src/application/bookmarks.ts';

const KEY = 'fly.bookmarks';

function memoryStorage(initial) {
  const map = new Map(initial ? Object.entries(initial) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

test('empty or missing storage means no bookmarks', () => {
  assert.deepEqual(loadBookmarks(null), []);
  assert.deepEqual(loadBookmarks(memoryStorage()), []);
  assert.deepEqual(loadBookmarks(memoryStorage({ [KEY]: 'not json' })), []);
});

test('round-trips bookmarks', () => {
  const storage = memoryStorage();
  const list = [{ name: 'news', link: 'nym://abc/feed', addedAt: 1 }];
  saveBookmarks(list, storage);
  assert.deepEqual(loadBookmarks(storage), list);
});

test('drops malformed entries', () => {
  const raw = JSON.stringify([
    { name: 'ok', link: 'nym://abc', addedAt: 1 },
    { name: '', link: 'nym://abc' },
    { name: 'no-link' },
    'nope',
    null,
  ]);
  assert.deepEqual(loadBookmarks(memoryStorage({ [KEY]: raw })), [
    { name: 'ok', link: 'nym://abc', addedAt: 1 },
  ]);
});

test('normalizeBookmarkName trims, collapses spaces, lower-cases', () => {
  assert.equal(normalizeBookmarkName('  My   News  '), 'my news');
});

test('addBookmark dedupes by normalized name and puts newest first', () => {
  let list = addBookmark([], { name: 'News', link: 'nym://a', addedAt: 1 });
  list = addBookmark(list, { name: 'mail', link: 'nym://b', addedAt: 2 });
  list = addBookmark(list, { name: '  news ', link: 'nym://c', addedAt: 3 });
  assert.equal(list.length, 2, 'duplicate name is a no-op');
  assert.deepEqual(
    list.map((b) => b.name),
    ['mail', 'news'],
  );
  assert.equal(list[1].link, 'nym://a', 'the original link is kept, not overwritten');
});

test('addBookmark ignores empty name or link', () => {
  assert.equal(addBookmark([], { name: '  ', link: 'nym://a' }).length, 0);
  assert.equal(addBookmark([], { name: 'x', link: '   ' }).length, 0);
});

test('addBookmark caps the list', () => {
  let list = [];
  for (let i = 0; i < MAX_BOOKMARKS + 10; i += 1) {
    list = addBookmark(list, { name: `b${i}`, link: `nym://${i}` });
  }
  assert.equal(list.length, MAX_BOOKMARKS);
});

test('removeBookmark drops by normalized name without mutating input', () => {
  const list = [
    { name: 'news', link: 'nym://a', addedAt: 1 },
    { name: 'mail', link: 'nym://b', addedAt: 2 },
  ];
  const next = removeBookmark(list, ' NEWS ');
  assert.deepEqual(
    next.map((b) => b.name),
    ['mail'],
  );
  assert.equal(list.length, 2, 'input untouched');
});

test('isBookmarked matches the exact link only', () => {
  const list = [{ name: 'news', link: 'nym://a', addedAt: 1 }];
  assert.equal(isBookmarked(list, 'nym://a'), true);
  assert.equal(isBookmarked(list, ' nym://a '), true);
  assert.equal(isBookmarked(list, 'nym://b'), false);
  assert.equal(isBookmarked(list, ''), false);
});

test('defaultBookmarkStorage is null without a DOM', () => {
  assert.equal(defaultBookmarkStorage(), null);
});
