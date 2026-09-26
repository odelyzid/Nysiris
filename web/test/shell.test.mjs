// Run with: node --test web/test
// Verifies desktop-shell persistence (recent portals, favourites, context
// panel, active thread) without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FAVORITE_PORTALS,
  MAX_RECENT_PORTALS,
  isFavoritePortal,
  loadActiveThread,
  loadContextOpen,
  loadFavoritePortals,
  loadRecentPortals,
  rememberPortal,
  saveActiveThread,
  saveContextOpen,
  saveFavoritePortals,
  saveRecentPortals,
  toggleFavoritePortal,
} from '../src/application/shell.ts';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

test('rememberPortal dedupes, fronts, and caps', () => {
  assert.deepEqual(rememberPortal([], '  addr1 '), ['addr1']);
  assert.deepEqual(rememberPortal(['a', 'b'], 'b'), ['b', 'a']);
  assert.deepEqual(rememberPortal(['a'], '  '), ['a']);
  const many = Array.from({ length: MAX_RECENT_PORTALS + 3 }, (_, i) => `p${i}`);
  const out = rememberPortal(many, 'new');
  assert.equal(out.length, MAX_RECENT_PORTALS);
  assert.equal(out[0], 'new');
});

test('recent portals round-trip and drop garbage', () => {
  const s = fakeStorage();
  saveRecentPortals(['a', 'b'], s);
  assert.deepEqual(loadRecentPortals(s), ['a', 'b']);
  assert.deepEqual(loadRecentPortals(fakeStorage()), []);
  assert.deepEqual(loadRecentPortals(fakeStorage({ 'fly.portals.recent': 'nope' })), []);
  assert.deepEqual(loadRecentPortals(fakeStorage({ 'fly.portals.recent': '["ok", 7, "", null]' })), ['ok']);
});

test('favourites toggle on and off, dedupe, trim, and cap', () => {
  let list = toggleFavoritePortal([], ' addr1 ');
  assert.deepEqual(list, ['addr1']);
  assert.equal(isFavoritePortal(list, 'addr1'), true);
  assert.equal(isFavoritePortal(list, '  '), false, 'empty is never favourited');
  // Toggle semantics: the star button flips state, so a second call removes.
  assert.deepEqual(toggleFavoritePortal(list, 'addr1'), []);
  // Newest first.
  list = toggleFavoritePortal(list, 'addr2');
  assert.deepEqual(list, ['addr2', 'addr1']);
  // Removing works and never mutates the input.
  const before = [...list];
  const after = toggleFavoritePortal(list, 'addr2');
  assert.deepEqual(after, ['addr1']);
  assert.deepEqual(list, before);
  // Capped like recents.
  const many = Array.from({ length: MAX_FAVORITE_PORTALS + 3 }, (_, i) => `p${i}`);
  const out = toggleFavoritePortal(many, 'new');
  assert.equal(out.length, MAX_FAVORITE_PORTALS);
  assert.equal(out[0], 'new');
});

test('favourites round-trip through storage and drop garbage', () => {
  const s = fakeStorage();
  saveFavoritePortals(['a', 'b'], s);
  assert.deepEqual(loadFavoritePortals(s), ['a', 'b']);
  assert.deepEqual(loadFavoritePortals(fakeStorage()), []);
  assert.deepEqual(loadFavoritePortals(fakeStorage({ 'fly.portals.favorites': 'nope' })), []);
  assert.deepEqual(loadFavoritePortals(fakeStorage({ 'fly.portals.favorites': '["ok", 7, "", null]' })), ['ok']);
});

test('context panel defaults to open', () => {
  assert.equal(loadContextOpen(fakeStorage()), true);
  const s = fakeStorage();
  saveContextOpen(false, s);
  assert.equal(loadContextOpen(s), false);
  saveContextOpen(true, s);
  assert.equal(loadContextOpen(s), true);
});

test('active thread round-trips', () => {
  assert.equal(loadActiveThread(fakeStorage()), null);
  const s = fakeStorage();
  saveActiveThread('contact:abc', s);
  assert.equal(loadActiveThread(s), 'contact:abc');
});
