// Run with: node --test web/test
// Document cache eviction/limits (memory-only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentCache } from '../src/application/documentCache.ts';

const page = (body, favicon = null) => ({ status: 200, contentType: 'text/html', body, favicon });

test('cache returns prepared pages and refreshes LRU order', () => {
  const cache = new DocumentCache({ maxEntries: 2 });
  cache.set('https://a/', page('A'));
  cache.set('https://b/', page('B'));
  assert.equal(cache.get('https://a/')?.body, 'A');
  cache.set('https://c/', page('C'));
  assert.equal(cache.get('https://b/'), null, 'least-recently used entry evicted');
  assert.equal(cache.get('https://a/')?.body, 'A');
  assert.equal(cache.get('https://c/')?.body, 'C');
  assert.deepEqual(cache.keys().sort(), ['https://a/', 'https://c/']);
});

test('cache caps total bytes and skips oversize entries', () => {
  // Each entry is 74 bytes (body + 64 overhead), so 180 fits two.
  const cache = new DocumentCache({ maxEntries: 10, maxBytes: 180 });
  cache.set('https://a/', page('1234567890'));
  cache.set('https://b/', page('1234567890'));
  assert.equal(cache.size, 2);
  cache.set('https://c/', page('1234567890'));
  assert.equal(cache.size, 2);
  assert.equal(cache.get('https://a/'), null, 'oldest entry evicted by byte cap');
  assert.equal(cache.get('https://c/')?.body, '1234567890');
  assert.ok(cache.byteSize <= 180);

  const oversized = new DocumentCache({ maxBytes: 5 });
  oversized.set('https://big/', page('1234567890'));
  assert.equal(oversized.size, 0);
});

test('updating and deleting entries adjusts the byte count', () => {
  const cache = new DocumentCache();
  cache.set('https://a/', page('short'));
  const before = cache.byteSize;
  cache.set('https://a/', page('a longer body'));
  assert.ok(cache.byteSize > before);
  cache.delete('https://a/');
  assert.equal(cache.size, 0);
  assert.equal(cache.byteSize, 0);
});
