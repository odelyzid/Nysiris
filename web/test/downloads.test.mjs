// Run with: node --test web/test
// Download shelf metadata: add/update/remove, storage, and size formatting.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DOWNLOADS,
  addDownload,
  clearDownloads,
  downloadProgress,
  formatSize,
  isResumable,
  loadDownloads,
  removeDownload,
  saveDownloads,
  updateDownload,
} from '../src/application/downloads.ts';

const record = (id, overrides = {}) => ({
  id,
  name: `${id}.bin`,
  url: `https://example.com/${id}`,
  contentType: 'application/octet-stream',
  size: 12,
  status: 'saved',
  createdAt: 1,
  ...overrides,
});

function memoryStorage() {
  let raw = null;
  return {
    getItem: () => raw,
    setItem: (_key, value) => {
      raw = value;
    },
  };
}

test('addDownload puts newest first and dedupes by id', () => {
  let list = [];
  list = addDownload(list, record('a'));
  list = addDownload(list, record('b'));
  list = addDownload(list, record('a', { name: 'new.bin' }));
  assert.deepEqual(
    list.map((entry) => entry.id),
    ['a', 'b'],
  );
  assert.equal(list[0].name, 'new.bin');
});

test('addDownload caps the shelf', () => {
  let list = [];
  for (let i = 0; i < MAX_DOWNLOADS + 5; i += 1) list = addDownload(list, record(`id-${i}`));
  assert.equal(list.length, MAX_DOWNLOADS);
  assert.equal(list[0].id, `id-${MAX_DOWNLOADS + 4}`);
});

test('updates, removes, and clears', () => {
  let list = [record('a'), record('b')];
  list = updateDownload(list, 'a', { status: 'failed', error: 'nope' });
  assert.equal(list[0].status, 'failed');
  assert.equal(list[0].error, 'nope');
  list = removeDownload(list, 'a');
  assert.deepEqual(
    list.map((entry) => entry.id),
    ['b'],
  );
  assert.deepEqual(clearDownloads(), []);
});

test('persists valid records and drops malformed ones', () => {
  const storage = memoryStorage();
  saveDownloads(storage, [record('a'), { nope: true }, record('b')]);
  const loaded = loadDownloads(storage);
  assert.deepEqual(
    loaded.map((entry) => entry.id),
    ['a', 'b'],
  );
  assert.deepEqual(loadDownloads(null), []);
});

test('formatSize is stable and readable', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(1023), '1023 B');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(2.5 * 1024 * 1024), '2.5 MB');
  assert.equal(formatSize(Number.NaN), '—');
});

test('partial downloads persist progress and can resume', () => {
  const storage = memoryStorage();
  const partial = record('p', {
    status: 'partial',
    received: 512,
    total: 2048,
    etag: '"v1"',
    error: 'connection lost',
  });
  saveDownloads(storage, [partial]);
  const [loaded] = loadDownloads(storage);
  assert.equal(loaded.status, 'partial');
  assert.equal(loaded.received, 512);
  assert.equal(loaded.total, 2048);
  assert.equal(loaded.etag, '"v1"');
  assert.equal(downloadProgress(loaded), 0.25);
  assert.equal(isResumable(loaded), true);

  assert.equal(downloadProgress(record('saved')), null, 'no total means no percentage');
  assert.equal(isResumable(record('saved')), false);
  assert.equal(isResumable(record('failed', { status: 'failed', received: 0 })), false);
  assert.equal(isResumable(record('failed', { status: 'failed', received: 10 })), true);
});
