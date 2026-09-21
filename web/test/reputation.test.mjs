// Run with: node --test web/test
// Local reputation: same weights/thresholds/decay as the Rust implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReputation,
  DECAY_HALF_LIFE_DAYS,
  standingOf,
} from '../src/mixnet/reputation.mjs';

test('thresholds match the documented bands', () => {
  assert.equal(standingOf(20), 'trusted');
  assert.equal(standingOf(0), 'neutral');
  assert.equal(standingOf(-9), 'watch');
  assert.equal(standingOf(-10), 'blocked');
});

test('scores observations and clamps volume', () => {
  const rep = createReputation();
  assert.equal(rep.standing('alice', 100), 'unknown');
  for (let i = 0; i < 25; i += 1) rep.observe('alice', 'valid', 100);
  assert.equal(rep.standing('alice', 100), 'trusted');
  rep.observe('mallory', 'invalidSignature', 100);
  rep.observe('mallory', 'invalidSignature', 100);
  assert.equal(rep.standing('mallory', 100), 'blocked');
  for (let i = 0; i < 200; i += 1) rep.observe('alice', 'valid', 100);
  assert.equal(rep.score('alice', 100), 100);
});

test('silence decays toward neutral', () => {
  const rep = createReputation();
  for (let i = 0; i < 25; i += 1) rep.observe('alice', 'valid', 100);
  assert.equal(rep.score('alice', 100 + DECAY_HALF_LIFE_DAYS), 12);
  assert.equal(rep.standing('alice', 100 + DECAY_HALF_LIFE_DAYS * 10), 'neutral');
});

test('serializes for persistence and repairs garbage', () => {
  const rep = createReputation();
  rep.observe('alice', 'valid', 100);
  const saved = rep.toJSON();
  const rep2 = createReputation();
  rep2.load(saved, 100);
  assert.equal(rep2.score('alice', 100), rep.score('alice', 100));
  const rep3 = createReputation();
  rep3.load('nope', 100);
  rep3.load([{ author: 'x' }], 100);
  assert.equal(rep3.size(), 0);
});
