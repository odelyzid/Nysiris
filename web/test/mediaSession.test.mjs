// Run with: node --test web/test
// Media bridge: byte-range parsing and session lookup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentRange, parseRangeHeader, rangeLength } from '../src/shared/mediaRange.ts';
import {
  MEDIA_PATH_PREFIX,
  MediaSessionRegistry,
  isStreamableContentType,
  looksLikeStreamableUrl,
  mediaPath,
  mediaStreamingAvailable,
} from '../src/application/mediaSession.ts';

test('parses open, closed, and suffix byte ranges', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRangeHeader('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRangeHeader('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRangeHeader('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRangeHeader('bytes=10-999', 100), { start: 10, end: 99 });
  assert.equal(parseRangeHeader('bytes=100-', 100), null);
  assert.equal(parseRangeHeader('bytes=20-10', 100), null);
  assert.equal(parseRangeHeader('items=0-1', 100), null);
  assert.equal(parseRangeHeader('bytes=0-', null), null);
});

test('formats content ranges and lengths', () => {
  assert.equal(contentRange(0, 99, 100), 'bytes 0-99/100');
  assert.equal(contentRange(0, 9, null), 'bytes 0-9/*');
  assert.equal(rangeLength({ start: 10, end: 19 }), 10);
});

test('sessions map random tokens to canonical media descriptors', () => {
  const registry = new MediaSessionRegistry({ makeToken: () => 'token-1', now: () => 42 });
  const session = registry.register({
    url: 'nym://abc.def@gw/movie.mp4',
    contentType: 'video/mp4',
    total: 10,
    etag: '"v1"',
    title: 'Movie',
  });
  assert.equal(session.token, 'token-1');
  assert.equal(session.createdAt, 42);
  assert.equal(registry.get('token-1')?.url, 'nym://abc.def@gw/movie.mp4');
  assert.equal(registry.size, 1);
  registry.unregister('token-1');
  assert.equal(registry.get('token-1'), null);
  assert.equal(registry.size, 0);
});

test('media paths are same-origin and encoded', () => {
  assert.equal(mediaPath('a b'), `${MEDIA_PATH_PREFIX}a%20b`);
  assert.equal(MEDIA_PATH_PREFIX, '/__nysiris-media/');
  assert.equal(mediaStreamingAvailable(), false, 'no service worker in node');
});

test('streamable URL/type hints are conservative', () => {
  assert.equal(looksLikeStreamableUrl('https://x/movie.mp4'), true);
  assert.equal(looksLikeStreamableUrl('https://x/report.PDF?x=1'), true);
  assert.equal(looksLikeStreamableUrl('https://x/page.html'), false);
  assert.equal(isStreamableContentType('video/mp4'), true);
  assert.equal(isStreamableContentType('application/pdf'), true);
  assert.equal(isStreamableContentType('text/html'), false);
});
