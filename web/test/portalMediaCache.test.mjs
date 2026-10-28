// Run with: node --test web/test
// Offline media cache: memory store and full range download.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryMediaCache,
  downloadMediaToCache,
} from '../src/application/portalMediaCache.ts';

test('memory cache round-trips and clears', async () => {
  const cache = new MemoryMediaCache();
  await cache.save({ url: 'https://x/a.mp4', contentType: 'video/mp4', bytes: new Uint8Array([1, 2]), cachedAt: 5 });
  const loaded = await cache.load('https://x/a.mp4');
  assert.deepEqual([...loaded.bytes], [1, 2]);
  assert.equal(loaded.contentType, 'video/mp4');
  await cache.clear('https://x/a.mp4');
  assert.equal(await cache.load('https://x/a.mp4'), null);
});

test('downloadMediaToCache assembles ranges and stores the result', async () => {
  const cache = new MemoryMediaCache();
  const calls = [];
  const fetcher = async (request) => {
    calls.push(request.start);
    if (request.start === 0) {
      return { status: 206, headers: { 'content-range': 'bytes 0-1/4' }, body: new Uint8Array([1, 2]) };
    }
    if (request.start === 2) {
      return { status: 206, headers: { 'content-range': 'bytes 2-3/4' }, body: new Uint8Array([3, 4]) };
    }
    throw new Error('unexpected range');
  };
  const media = await downloadMediaToCache(fetcher, cache, 'nym://a.b@g/m.mp4', 'video/mp4', 4);
  assert.deepEqual([...media.bytes], [1, 2, 3, 4]);
  assert.deepEqual(calls, [0, 2]);
  assert.deepEqual([...(await cache.load('nym://a.b@g/m.mp4')).bytes], [1, 2, 3, 4]);
});
