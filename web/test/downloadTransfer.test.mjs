// Run with: node --test web/test
// Resumable range downloader: resume, restart, bounds, abort, partial errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TransferError, transferRanges } from '../src/application/downloadTransfer.ts';

const bytes = (...values) => new Uint8Array(values);

function queue(...responses) {
  const calls = [];
  const fetcher = async (request, signal) => {
    calls.push({ request, signal });
    const next = responses.shift();
    if (!next) throw new Error('no response queued');
    return typeof next === 'function' ? next(request, signal) : next;
  };
  return { fetcher, calls };
}

test('resumes from retained bytes and assembles the complete body', async () => {
  const progress = [];
  const { fetcher, calls } = queue(
    { status: 206, headers: { 'content-range': 'bytes 2-3/5' }, body: bytes(3, 4) },
    { status: 206, headers: { 'content-range': 'bytes 4-4/5' }, body: bytes(5) },
  );

  const result = await transferRanges(fetcher, {
    initial: bytes(1, 2),
    total: 5,
    etag: '"v1"',
    onProgress: (received, total) => progress.push([received, total]),
  });

  assert.deepEqual([...result.bytes], [1, 2, 3, 4, 5]);
  assert.equal(result.received, 5);
  assert.equal(result.total, 5);
  assert.equal(result.resumed, true);
  assert.deepEqual(
    calls.map((call) => [call.request.start, call.request.etag]),
    [
      [2, '"v1"'],
      [4, '"v1"'],
    ],
  );
  assert.deepEqual(progress, [
    [4, 5],
    [5, 5],
  ]);
});

test('a 200 response restarts the transfer instead of duplicating the prefix', async () => {
  const { fetcher, calls } = queue({ status: 200, headers: { 'content-length': '3' }, body: bytes(9, 8, 7) });
  const result = await transferRanges(fetcher, { initial: bytes(1, 2), total: 5, etag: '"v1"' });
  assert.deepEqual([...result.bytes], [9, 8, 7]);
  assert.equal(result.resumed, false);
  assert.equal(result.total, 3);
  assert.equal(calls[0].request.start, 2, 'the server still sees the resume offset');
});

test('a failed transfer carries the bytes received so far', async () => {
  const { fetcher } = queue(
    { status: 206, headers: { 'content-range': 'bytes 0-1/5' }, body: bytes(1, 2) },
    { status: 500, headers: {}, body: new Uint8Array(0) },
  );
  await assert.rejects(transferRanges(fetcher, { total: 5 }), (error) => {
    assert.ok(error instanceof TransferError);
    assert.deepEqual([...error.bytes], [1, 2]);
    assert.equal(error.received, 2);
    assert.equal(error.total, 5);
    return /HTTP 500/.test(error.message);
  });
});

test('abort before and during a transfer rejects with AbortError', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    transferRanges(async () => ({ status: 200, headers: {}, body: bytes(1) }), { signal: before.signal }),
    (error) => error.name === 'AbortError',
  );

  const during = new AbortController();
  const { fetcher } = queue({ status: 206, headers: { 'content-range': 'bytes 0-0/2' }, body: bytes(1) });
  await assert.rejects(
    transferRanges(fetcher, {
      total: 2,
      signal: during.signal,
      onProgress: () => during.abort(),
    }),
    (error) => error.name === 'AbortError' && [...error.bytes].join(',') === '1',
  );
});

test('completed or rejected ranges terminate correctly', async () => {
  let called = 0;
  const alreadyDone = await transferRanges(
    async () => {
      called += 1;
      return { status: 200, headers: {}, body: bytes(1) };
    },
    { initial: bytes(1, 2, 3), total: 3 },
  );
  assert.deepEqual([...alreadyDone.bytes], [1, 2, 3]);
  assert.equal(called, 0, 'nothing is fetched when the prefix is already complete');

  const rejected = queue({ status: 416, headers: { 'content-range': 'bytes */5' }, body: new Uint8Array(0) });
  await assert.rejects(transferRanges(rejected.fetcher, { initial: bytes(1, 2), total: 5 }), /resume offset/);
});

test('gaps, empty chunks, and oversized downloads fail loudly', async () => {
  const gap = queue({ status: 206, headers: { 'content-range': 'bytes 0-1/5' }, body: bytes(1, 2) });
  await assert.rejects(transferRanges(gap.fetcher, { initial: bytes(1, 2), total: 5 }), /range gap/);

  const empty = queue({ status: 206, headers: { 'content-range': 'bytes 0-0/5' }, body: new Uint8Array(0) });
  await assert.rejects(transferRanges(empty.fetcher, { total: 5 }), /empty chunk/);

  const huge = queue({
    status: 206,
    headers: { 'content-range': 'bytes 0-9/10' },
    body: bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
  });
  await assert.rejects(transferRanges(huge.fetcher, { total: 10, maxBytes: 5 }), /too large/);
});

test('an unknown total is inferred from a complete 200 response', async () => {
  const { fetcher } = queue({ status: 200, headers: {}, body: bytes(4, 5, 6) });
  const result = await transferRanges(fetcher, {});
  assert.deepEqual([...result.bytes], [4, 5, 6]);
  assert.equal(result.total, 3);
});
