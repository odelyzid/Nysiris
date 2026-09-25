// Run with: node --test web/test
// Pure blob-upload protocol: chunk count, PoW preimages, part request bodies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOB_MAX_PARTS,
  BLOB_PART_BYTES,
  blobPartBody,
  blobPartCount,
  blobPartPreimage,
  formatBytes,
  isImageMime,
} from '../src/domain/blobUpload.ts';

const ID = 'aa'.repeat(32);

test('blobPartCount splits by chunk size and caps', () => {
  assert.equal(blobPartCount(0), 0);
  assert.equal(blobPartCount(1), 1);
  assert.equal(blobPartCount(BLOB_PART_BYTES), 1);
  assert.equal(blobPartCount(BLOB_PART_BYTES + 1), 2);
  assert.equal(blobPartCount(BLOB_PART_BYTES * BLOB_MAX_PARTS), BLOB_MAX_PARTS);
  assert.equal(blobPartCount(BLOB_PART_BYTES * BLOB_MAX_PARTS + 1), BLOB_MAX_PARTS + 1);
});

test('blobPartPreimage binds id || part_be32 || chunk', () => {
  const chunk = new Uint8Array([0x61, 0x62, 0x63]); // "abc"
  const pre = blobPartPreimage(ID, 2, chunk);
  assert.equal(pre.length, 32 + 4 + 3);
  assert.deepEqual(pre.subarray(0, 32), new Uint8Array(32).fill(0xaa));
  // part = 2 → big-endian u32.
  assert.deepEqual(pre.subarray(32, 36), new Uint8Array([0, 0, 0, 2]));
  assert.deepEqual(pre.subarray(36), chunk);
});

test('blobPartBody builds the wire request with optional pow', () => {
  const chunk = new Uint8Array([1, 2, 3]);
  const noPow = blobPartBody(ID, 0, 3, chunk);
  assert.equal(noPow.path, `/blob/part?id=${ID}&part=0&of=3`);
  const body = JSON.parse(new TextDecoder().decode(noPow.body));
  assert.equal(body.bytes_b64, 'AQID');

  const withPow = blobPartBody(ID, 1, 3, chunk, { nonce: 7, bits: 16 });
  const pbody = JSON.parse(new TextDecoder().decode(withPow.body));
  assert.deepEqual(pbody.pow, { nonce: 7, bits: 16 });
});

test('formatBytes and isImageMime stay presentation-pure', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.00 MB');
  assert.equal(isImageMime('image/webp'), true);
  assert.equal(isImageMime('application/pdf'), false);
});