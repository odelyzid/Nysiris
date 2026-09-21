// Run with: node --test web/test
// Verifies partial-replica merge and sync status text without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_KEPT_POSTS, describeSync, mergeFeedPosts } from '../src/social/sync.ts';

test('merge dedupes by seq and keeps ascending order', () => {
  const prev = [{ seq: 1 }, { seq: 3 }];
  const merged = mergeFeedPosts(prev, [{ seq: 2 }, { seq: 3 }, { seq: 4 }]);
  assert.deepEqual(
    merged.map((p) => p.seq),
    [1, 2, 3, 4],
  );
  // Inputs untouched.
  assert.deepEqual(
    prev.map((p) => p.seq),
    [1, 3],
  );
});

test('merge caps kept history', () => {
  const prev = [];
  const incoming = Array.from({ length: MAX_KEPT_POSTS + 50 }, (_, i) => ({ seq: i + 1 }));
  const merged = mergeFeedPosts(prev, incoming);
  assert.equal(merged.length, MAX_KEPT_POSTS);
  assert.equal(merged[0].seq, 51);
});

test('sync status reads friendly in every state', () => {
  const now = 1_000_000;
  assert.equal(describeSync(now, { syncing: true, lastSyncedAt: 0, error: null }).tone, 'busy');
  assert.equal(
    describeSync(now, { syncing: false, lastSyncedAt: null, error: null }).text,
    'Not synced yet.',
  );
  assert.equal(
    describeSync(now, { syncing: false, lastSyncedAt: now - 5_000, error: null }).text,
    'Up to date — checked just now.',
  );
  assert.equal(
    describeSync(now, { syncing: false, lastSyncedAt: now - 40_000, error: null }).text,
    'Up to date — checked 40s ago.',
  );
  const bad = describeSync(now, { syncing: false, lastSyncedAt: now, error: 'timed out' });
  assert.equal(bad.tone, 'bad');
  assert.match(bad.text, /timed out/);
});
