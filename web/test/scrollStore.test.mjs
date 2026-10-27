// Run with: node --test web/test
// Scroll position persistence (injected storage, no DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SCROLL_ENTRIES,
  loadScrollPositions,
  rememberScroll,
  saveScrollPositions,
} from '../src/application/scrollStore.ts';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    dump: () => data,
  };
}

test('round-trips valid scroll positions and drops garbage', () => {
  const storage = memoryStorage();
  saveScrollPositions(storage, {
    'https://a/': 120,
    'nym://id.enc@gw/': 44,
    'javascript:alert(1)': 9,
    'https://b/': -3,
    'https://c/': Number.NaN,
  });
  const loaded = loadScrollPositions(storage);
  assert.deepEqual(loaded, { 'https://a/': 120, 'nym://id.enc@gw/': 44 });
});

test('rememberScroll updates one URL without dropping the rest', () => {
  const storage = memoryStorage();
  rememberScroll(storage, 'https://a/', 10);
  rememberScroll(storage, 'https://b/', 20);
  rememberScroll(storage, 'https://a/', 30);
  assert.deepEqual(loadScrollPositions(storage), { 'https://b/': 20, 'https://a/': 30 });
});

test('restoring survives malformed storage and caps entries', () => {
  assert.deepEqual(loadScrollPositions(memoryStorage({ 'fly.browser.scroll.v1': 'not json' })), {});
  const positions = {};
  for (let i = 0; i < MAX_SCROLL_ENTRIES + 20; i += 1) positions[`https://x/${i}`] = i;
  const storage = memoryStorage();
  saveScrollPositions(storage, positions);
  const loaded = loadScrollPositions(storage);
  assert.ok(Object.keys(loaded).length <= MAX_SCROLL_ENTRIES);
  assert.equal(loaded[`https://x/${MAX_SCROLL_ENTRIES + 19}`], MAX_SCROLL_ENTRIES + 19);
});
