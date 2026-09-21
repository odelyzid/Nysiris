// Run with: node --test web/test
//
// Adversarial simulation for the browser-runtime enforcement controls
// (docs/05-security.md §§5.3–5.4, 5.8). Unit tests prove single behaviours;
// these tests throw hostile network conditions at `ReplyTracker` and
// `ReplyBudget`: replay storms, SURB hoarding bursts, duplicates interleaved
// with legitimate traffic, non-monotonic clocks, and randomised op sequences
// checked against a simple model. Deterministic: a seeded PRNG, no timing
// dependence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_TRACKED_REPLIES,
  DEFAULT_SURB_MAX_AGE_MS,
  ReplyBudget,
  ReplyTracker,
  messageKey,
} from '../src/mixnet/enforcement.mjs';

/** mulberry32: small seeded PRNG so the chaos is reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('replay storm: N copies of one reply are processed exactly once', () => {
  const tracker = new ReplyTracker({ ttlMs: DEFAULT_SURB_MAX_AGE_MS });
  const key = messageKey('hoarded-tag', 'burst-payload');
  let accepted = 0;
  for (let i = 0; i < 10_000; i += 1) {
    if (tracker.accept(key)) accepted += 1;
  }
  assert.equal(accepted, 1, 'replay storm must not bypass single-use');
});

test('SURB hoarding burst: many distinct replies, then the same burst again', () => {
  const tracker = new ReplyTracker({ ttlMs: DEFAULT_SURB_MAX_AGE_MS });
  const burst = Array.from({ length: 500 }, (_, i) => messageKey('tag', `reply-${i}`));
  for (const key of burst) assert.equal(tracker.accept(key), true);
  let duplicates = 0;
  for (const key of burst) {
    if (!tracker.accept(key)) duplicates += 1;
  }
  assert.equal(duplicates, burst.length, 'second burst must be fully rejected');
});

test('duplicates interleaved with legitimate traffic stay contained', () => {
  let now = 0;
  const tracker = new ReplyTracker({ ttlMs: 60_000, now: () => now });
  const rand = prng(42);
  const seen = new Set();
  let accepted = 0;
  let rejected = 0;
  for (let i = 0; i < 5_000; i += 1) {
    now += Math.floor(rand() * 10);
    // 30% chance: replay a previously seen key (adversary); else a fresh one.
    let key;
    if (seen.size > 0 && rand() < 0.3) {
      const arr = [...seen];
      key = arr[Math.floor(rand() * arr.length)];
    } else {
      key = messageKey(`tag-${Math.floor(rand() * 20)}`, `payload-${i}`);
    }
    if (tracker.accept(key)) {
      accepted += 1;
      seen.add(key);
    } else {
      rejected += 1;
    }
  }
  // Every accepted key is unique by construction; rejections are all replays.
  assert.equal(accepted, seen.size);
  assert.ok(rejected > 0, 'expected some replays to be refused');
  assert.ok(tracker.size <= DEFAULT_MAX_TRACKED_REPLIES, 'memory stays bounded');
});

test('non-monotonic clock cannot resurrect or duplicate entries', () => {
  let now = 1_000_000;
  const tracker = new ReplyTracker({ ttlMs: 60_000, now: () => now });
  const key = messageKey('tag', 'payload');
  assert.equal(tracker.accept(key), true);
  now -= 500_000; // clock jumps backwards
  assert.equal(tracker.accept(key), false, 'duplicate still refused after clock skew');
  assert.equal(tracker.accept(messageKey('tag', 'other')), true, 'fresh keys still accepted');
});

test('expiry lets a key through exactly once per window, never twice in one', () => {
  let now = 0;
  const tracker = new ReplyTracker({ ttlMs: 1_000, now: () => now });
  const key = messageKey('tag', 'payload');
  assert.equal(tracker.accept(key), true);
  assert.equal(tracker.accept(key), false);
  now = 1_001; // window passes; stale entry purged
  assert.equal(tracker.accept(key), true, 're-accept after expiry is a new window');
  assert.equal(tracker.accept(key), false);
});

test('reply-budget flood: burst spend is capped, trickle survives', () => {
  let now = 0;
  const budget = new ReplyBudget(5, 1, () => now); // 5 burst, 1/s sustained
  let accepted = 0;
  for (let i = 0; i < 1_000; i += 1) {
    if (budget.tryTake()) accepted += 1;
  }
  assert.equal(accepted, 5, 'instant flood capped at capacity');
  // A slow legitimate sender over the next minute gets the sustained rate.
  let trickle = 0;
  for (let s = 1; s <= 60; s += 1) {
    now = s * 1000;
    if (budget.tryTake()) trickle += 1;
  }
  assert.ok(trickle >= 55, `sustained sender starved: only ${trickle}/60`);
});

test('randomised op sequence matches a reference model', () => {
  const rand = prng(1337);
  const TTL = 10_000;
  let now = 0;
  const tracker = new ReplyTracker({ ttlMs: TTL, maxEntries: 256, now: () => now });
  const budget = new ReplyBudget(8, 4, () => now);
  /** Model: key -> accept time; purged with the same cutoff rule as ReplyTracker. */
  const window = new Map();
  const purgeModel = () => {
    const cutoff = now - TTL;
    for (const [key, seenAt] of window) {
      if (seenAt < cutoff) window.delete(key);
    }
  };
  let violations = 0;
  for (let i = 0; i < 20_000; i += 1) {
    now += Math.floor(rand() * 50);
    purgeModel();
    const op = rand();
    if (op < 0.6) {
      const key = messageKey(`t${Math.floor(rand() * 8)}`, `m${Math.floor(rand() * 40)}`);
      const got = tracker.accept(key);
      const want = !window.has(key);
      if (got !== want) violations += 1;
      // Mirror the tracker exactly: only a genuinely new accept (re)starts
      // the TTL clock; a refused duplicate changes nothing.
      if (got) window.set(key, now);
      // maxEntries eviction can drop the oldest model key too; mirror it.
      if (window.size > 256) {
        const oldest = window.keys().next().value;
        window.delete(oldest);
      }
    } else if (op < 0.8) {
      // Adversary replays a recent key verbatim.
      const keys = [...window.keys()];
      if (keys.length > 0) {
        const key = keys[Math.floor(rand() * keys.length)];
        if (tracker.accept(key)) violations += 1; // must never accept a replay
      }
    } else {
      // Budget spend interleaved for realism; bounded by construction.
      budget.tryTake();
    }
  }
  assert.equal(violations, 0, 'tracker diverged from the single-use model');
  assert.ok(tracker.size <= 256, 'tracker memory bounded under chaos');
});
