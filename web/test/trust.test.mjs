// Run with: node --test web/test
// Verifies local trust display rules without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STANDING_META,
  cautionFor,
  defaultTrustStorage,
  loadTrust,
  resolveStanding,
  saveTrust,
  shouldCollapse,
  standingTitle,
  withVerdict,
} from '../src/social/trust.ts';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

const HEX = 'ab'.repeat(32);

test('every standing has a label, color, and blurb', () => {
  for (const [standing, meta] of Object.entries(STANDING_META)) {
    assert.ok(meta.label.length > 0, standing);
    assert.match(meta.color, /^#[0-9a-f]{6}$/i, standing);
    assert.ok(meta.blurb.length > 0, standing);
  }
});

test('explicit verdict wins over observed standing', () => {
  assert.equal(resolveStanding('blocked', 'trusted'), 'blocked');
  assert.equal(resolveStanding('trusted', 'watch'), 'trusted');
  assert.equal(resolveStanding(null, 'watch'), 'watch');
  assert.equal(resolveStanding(undefined, 'neutral'), 'neutral');
});

test('titles say where the call came from', () => {
  assert.match(standingTitle('trusted', true), /your call/);
  assert.match(standingTitle('watch', false), /read carefully/);
});

test('blocked collapses, watch cautions, everything else renders inline', () => {
  assert.equal(shouldCollapse('blocked'), true);
  for (const s of ['trusted', 'neutral', 'watch', 'unknown']) assert.equal(shouldCollapse(s), false);
  assert.match(cautionFor('watch'), /read carefully/i);
  for (const s of ['trusted', 'neutral', 'blocked', 'unknown']) assert.equal(cautionFor(s), null);
});

test('verdicts round-trip per author', () => {
  const storage = fakeStorage();
  saveTrust(withVerdict(loadTrust(storage), HEX, 'blocked'), storage);
  assert.deepEqual(loadTrust(storage), { [HEX]: 'blocked' });
});

test('clearing a verdict removes the author', () => {
  assert.deepEqual(withVerdict({ [HEX]: 'blocked' }, HEX, null), {});
});

test('bad keys and verdicts never stick', () => {
  assert.deepEqual(withVerdict({}, 'not-hex', 'trusted'), {});
  assert.deepEqual(
    loadTrust(fakeStorage({ 'fly.social.trust': JSON.stringify({ [HEX]: 'admired', nope: 'trusted' }) })),
    {},
  );
  assert.deepEqual(loadTrust(fakeStorage({ 'fly.social.trust': 'garbage' })), {});
  assert.deepEqual(loadTrust(null), {});
});

test('defaultTrustStorage is null without a DOM', () => {
  assert.equal(defaultTrustStorage(), null);
});
