// Run with: node --test web/test
// Chunked-response parsing/assembly for large mixnet documents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeChunks, parseContentRange, responseTotal } from '../src/application/ranges.ts';

test('parses standard Content-Range values', () => {
  assert.deepEqual(parseContentRange('bytes 0-1399/5000'), { start: 0, end: 1399, total: 5000 });
  assert.equal(parseContentRange('bytes 1400-2799/*').total, null);
  assert.equal(parseContentRange('bytes 10-5/100'), null);
  assert.deepEqual(parseContentRange('bytes 0-9/10'), { start: 0, end: 9, total: 10 });
  assert.equal(parseContentRange('bytes 0-10/10'), null, 'total must exceed end');
  assert.equal(parseContentRange('nonsense'), null);
});

test('responseTotal prefers Content-Range and falls back to the explicit header', () => {
  assert.equal(responseTotal({ 'content-range': 'bytes 0-99/1234' }), 1234);
  assert.equal(responseTotal({ 'x-nysiris-total-length': '2048' }), 2048);
  assert.equal(responseTotal({ 'Content-Range': 'bytes 0-99/1234' }), 1234, 'header names are case-insensitive');
  assert.equal(responseTotal({}), null);
  assert.equal(responseTotal({ 'x-nysiris-total-length': 'NaN' }), null);
});

test('mergeChunks assembles in order and enforces completeness', () => {
  const joined = mergeChunks([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])], 5);
  assert.deepEqual([...joined], [1, 2, 3, 4, 5]);
  assert.throws(() => mergeChunks([new Uint8Array([1, 2])], 3), /incomplete response/);
  // Extra bytes beyond total are ignored.
  assert.deepEqual([...mergeChunks([new Uint8Array([1, 2, 3])], 2)], [1, 2]);
});
