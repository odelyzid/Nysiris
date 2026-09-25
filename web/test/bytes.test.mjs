// Run with: node --test web/test
// Verifies the shared byte helpers in web/src/lib/bytes.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { b64decode, b64encode, u64be } from '../src/lib/bytes.ts';

test('b64encode/b64decode round-trip across chunk boundaries', () => {
  for (const n of [0, 1, 31, 32, 0x7fff, 0x8000, 0x8001, 100_000]) {
    const bytes = new Uint8Array(n).map((_, i) => i % 251);
    assert.deepEqual(b64decode(b64encode(bytes)), bytes, `round-trip failed for n=${n}`);
  }
});

test('b64encode matches the standard alphabet', () => {
  assert.equal(b64encode(new Uint8Array([0xfb, 0xef, 0xbe])), '++++');
  assert.equal(b64encode(new TextEncoder().encode('Man')), 'TWFu');
  assert.deepEqual(b64decode('TWFu'), new Uint8Array([77, 97, 110]));
});

test('b64decode accepts the empty string and ignores no padding', () => {
  assert.deepEqual(b64decode(''), new Uint8Array(0));
  assert.deepEqual(b64decode('TWE'), new Uint8Array([77, 97]));
});

test('u64be encodes big-endian 8-byte integers', () => {
  assert.deepEqual(u64be(0), new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual(u64be(1), new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]));
  assert.deepEqual(u64be(0x01020304), new Uint8Array([0, 0, 0, 0, 1, 2, 3, 4]));
  assert.deepEqual(u64be(86_400), new Uint8Array([0, 0, 0, 0, 0, 1, 0x51, 0x80]));
});