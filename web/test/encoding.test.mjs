// Run with: node --test web/test
// Content-Encoding decoding (identity/gzip/deflate/stacked/unsupported).
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentEncodings, decodeContentEncoding } from '../src/application/encoding.ts';

async function compress(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test('contentEncodings normalises lists and drops identity', () => {
  assert.deepEqual(contentEncodings('gzip'), ['gzip']);
  assert.deepEqual(contentEncodings(' GZip , identity , deflate '), ['gzip', 'deflate']);
  assert.deepEqual(contentEncodings(''), []);
  assert.deepEqual(contentEncodings(undefined), []);
});

test('identity passes bytes through unchanged', async () => {
  const bytes = new TextEncoder().encode('hello');
  assert.equal(await decodeContentEncoding(bytes, ''), bytes);
  assert.equal(await decodeContentEncoding(bytes, 'identity'), bytes);
  assert.equal(await decodeContentEncoding(new Uint8Array(0), 'gzip').then((b) => b.length), 0);
});

test('decodes gzip and deflate responses', async () => {
  const text = new TextEncoder().encode('a page over the mixnet '.repeat(50));
  const gzip = await compress(text, 'gzip');
  assert.deepEqual(await decodeContentEncoding(gzip, 'gzip'), text);
  assert.deepEqual(await decodeContentEncoding(gzip, 'x-gzip'), text);

  const deflate = await compress(text, 'deflate');
  assert.deepEqual(await decodeContentEncoding(deflate, 'deflate'), text);
});

test('stacked codings are decoded in reverse order', async () => {
  const text = new TextEncoder().encode('stacked');
  const once = await compress(text, 'gzip');
  const twice = await compress(once, 'gzip');
  assert.deepEqual(await decodeContentEncoding(twice, 'gzip, gzip'), text);
});

test('unknown codings fail with a clear message', async () => {
  await assert.rejects(
    decodeContentEncoding(new Uint8Array([1, 2, 3]), 'made-up'),
    /unsupported content-encoding: made-up/,
  );
});

test('an injected decompressor is used and the size cap is enforced', async () => {
  const seen = [];
  const out = await decodeContentEncoding(new Uint8Array([1]), 'gzip', {
    decompress: async (bytes, coding) => {
      seen.push([bytes.length, coding]);
      return new Uint8Array([9, 8, 7]);
    },
  });
  assert.deepEqual([...out], [9, 8, 7]);
  assert.deepEqual(seen, [[1, 'gzip']]);

  await assert.rejects(
    decodeContentEncoding(new Uint8Array([1]), 'gzip', {
      maxBytes: 2,
      decompress: async () => new Uint8Array([1, 2, 3]),
    }),
    /too large/,
  );
});
