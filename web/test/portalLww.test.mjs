// Run with: node --test web/test
// LWW portal map: deterministic convergence and tie-breaking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PortalLwwMap, compareDots } from '../src/domain/portalLww.ts';

const dot = (day, author, hash) => ({ day, author: author.repeat(64).slice(0, 64), objHash: hash.repeat(64).slice(0, 64) });
const a = dot(1, 'a', '1');
const b = dot(2, 'a', '2');

test('higher day wins; equal dots do not replace', () => {
  assert.equal(compareDots(a, b), -1);
  assert.equal(compareDots(b, a), 1);
  assert.equal(compareDots(a, { ...a }), 0);

  const map = new PortalLwwMap();
  assert.equal(map.insert('title', a, 'old'), true);
  assert.equal(map.insert('title', a, 'same'), false);
  assert.equal(map.get('title'), 'old');
  assert.equal(map.insert('title', b, 'new'), true);
  assert.equal(map.get('title'), 'new');
  assert.equal(map.getDot('title').day, 2);
});

test('merge is commutative and idempotent', () => {
  const left = new PortalLwwMap();
  left.insert('title', a, 'A');
  left.insert('bio', b, 'B');
  const right = new PortalLwwMap();
  right.insert('title', b, 'B2');
  right.insert('theme', a, 'dark');

  const one = new PortalLwwMap(left.toEntries());
  one.merge(right);
  const two = new PortalLwwMap(right.toEntries());
  two.merge(left);

  assert.deepEqual(one.toEntries(), two.toEntries());
  assert.equal(one.get('title'), 'B2');
  assert.equal(one.get('theme'), 'dark');
  one.merge(one.toEntries());
  assert.equal(one.size, 3);
});

test('drops malformed keys and dots', () => {
  const map = new PortalLwwMap();
  assert.equal(map.insert('', a, 'x'), false);
  assert.equal(map.insert('k', { day: -1, author: 'a', objHash: 'b' }, 'x'), false);
  assert.equal(map.insert('k', { day: 1, author: 'nope', objHash: 'b' }, 'x'), false);
  assert.equal(map.size, 0);
});
