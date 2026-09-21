// Run with: node --test web/test
// Verifies the browser-runtime enforcement controls (docs/05-security.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_TRACKED_REPLIES,
  DEFAULT_SURB_MAX_AGE_MS,
  ExitPolicy,
  ExitRotation,
  ReplyBudget,
  ReplyTracker,
  messageKey,
  requireCoverTraffic,
  stableHash,
} from '../src/mixnet/enforcement.mjs';

test('stableHash is deterministic and fixed width', () => {
  assert.equal(stableHash('hello'), stableHash('hello'));
  assert.notEqual(stableHash('hello'), stableHash('hellp'));
  assert.equal(stableHash('anything').length, 8);
});

test('messageKey distinguishes senders and payloads', () => {
  assert.equal(messageKey('tag-a', 'hi'), messageKey('tag-a', 'hi'));
  assert.notEqual(messageKey('tag-a', 'hi'), messageKey('tag-b', 'hi'));
  assert.notEqual(messageKey('tag-a', 'hi'), messageKey('tag-a', 'ho'));
  assert.match(messageKey(undefined, 'x'), /^no-tag:/);
});

test('ReplyTracker enforces single use', () => {
  let now = 1_000;
  const tracker = new ReplyTracker({ now: () => now });
  const key = messageKey('tag', 'reply');
  assert.equal(tracker.accept(key), true, 'first delivery is accepted');
  assert.equal(tracker.accept(key), false, 'duplicate is refused');
  assert.equal(tracker.size, 1);
});

test('ReplyTracker expires entries after the SURB window', () => {
  let now = 0;
  const tracker = new ReplyTracker({ ttlMs: DEFAULT_SURB_MAX_AGE_MS, now: () => now });
  const key = messageKey('tag', 'reply');
  assert.equal(tracker.accept(key), true);

  now = DEFAULT_SURB_MAX_AGE_MS + 1;
  // The stale entry is purged, so the same key looks new again after expiry.
  assert.equal(tracker.purge(), 1);
  assert.equal(tracker.size, 0);
  assert.equal(tracker.accept(key), true);
});

test('ReplyTracker bounds its memory', () => {
  let now = 0;
  const tracker = new ReplyTracker({ maxEntries: 2, ttlMs: 1e12, now: () => now++ });
  tracker.accept('a');
  tracker.accept('b');
  tracker.accept('c');
  assert.equal(tracker.size, 2, 'oldest entry evicted');
});

test('ReplyBudget limits bursts and refills over time', () => {
  let now = 0;
  const budget = new ReplyBudget(3, 2, () => now);
  assert.equal(budget.tryTake(), true);
  assert.equal(budget.tryTake(), true);
  assert.equal(budget.tryTake(), true);
  assert.equal(budget.tryTake(), false, 'bucket exhausted');

  now = 1000; // +2 tokens
  assert.equal(budget.available(), 2);
  assert.equal(budget.tryTake(), true);
  assert.equal(budget.tryTake(), true);
  assert.equal(budget.tryTake(), false);

  now = 60_000; // long idle caps at capacity
  assert.equal(budget.available(), 3);
});

test('requireCoverTraffic fails closed on a downgrade without acknowledgement', () => {
  assert.throws(() => requireCoverTraffic({ coverTraffic: false, poissonPacing: true }, false));
  assert.throws(() => requireCoverTraffic({ coverTraffic: true, poissonPacing: false }, false));
  assert.doesNotThrow(() =>
    requireCoverTraffic({ coverTraffic: false, poissonPacing: false }, true),
  );
  assert.doesNotThrow(() => requireCoverTraffic(undefined, false));
});

test('ExitPolicy recommends reconnect per policy', () => {
  const pinned = new ExitPolicy({ policy: ExitRotation.Pinned });
  pinned.recordRequest();
  assert.equal(pinned.shouldRecommendReconnect(), false, 'pinning accepts the trade-off');

  const every = new ExitPolicy({ policy: ExitRotation.Every, maxRequests: 2 });
  every.recordRequest();
  assert.equal(every.shouldRecommendReconnect(), false);
  every.recordRequest();
  assert.equal(every.shouldRecommendReconnect(), true);

  const perRequest = new ExitPolicy({ policy: ExitRotation.PerRequest });
  perRequest.recordRequest();
  assert.equal(perRequest.shouldRecommendReconnect(), true);
});

test('documented defaults are stable', () => {
  assert.equal(DEFAULT_SURB_MAX_AGE_MS, 25 * 60 * 60 * 1000);
  assert.equal(DEFAULT_MAX_TRACKED_REPLIES, 4096);
});

test('ExitPolicy jitter randomises the reconnect threshold deterministically', () => {
  // random() = 0 -> lowest end of the window.
  const low = new ExitPolicy({ policy: ExitRotation.Every, maxRequests: 50, jitter: 10, random: () => 0 });
  assert.equal(low.threshold, 40);
  // random() ~ 1 -> highest end of the window.
  const high = new ExitPolicy({
    policy: ExitRotation.Every,
    maxRequests: 50,
    jitter: 10,
    random: () => 0.9999,
  });
  assert.equal(high.threshold, 60);
  // No jitter: exact legacy behaviour.
  const exact = new ExitPolicy({ policy: ExitRotation.Every, maxRequests: 2 });
  assert.equal(exact.threshold, 2);
  // Threshold is stable across requests (drawn once, not per call).
  const stable = new ExitPolicy({
    policy: ExitRotation.Every,
    maxRequests: 50,
    jitter: 10,
    random: () => 0.5,
  });
  const first = stable.threshold;
  stable.recordRequest();
  assert.equal(stable.shouldRecommendReconnect(), stable.count >= first);
  // reset() starts a fresh window and redraws the threshold.
  stable.reset();
  assert.equal(stable.count, 0);
  assert.equal(stable.shouldRecommendReconnect(), false);
});
