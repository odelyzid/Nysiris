// Run with: node --test web/test
// Verifies local author petnames without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorLabel,
  cleanPetname,
  duplicatePetnames,
  loadPetnames,
  savePetnames,
  withPetname,
} from '../src/social/petnames.ts';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

const HEX = 'cd'.repeat(32);

test('display priority is petname, then profile name, then short hex', () => {
  assert.equal(authorLabel(HEX, 'Maya', 'ada'), 'Maya');
  assert.equal(authorLabel(HEX, null, 'ada'), 'ada');
  assert.equal(authorLabel(HEX, '  ', 'ada'), 'ada');
  assert.equal(authorLabel(HEX, null, null), `${HEX.slice(0, 12)}…`);
});

test('petnames are trimmed and collapsed', () => {
  assert.equal(cleanPetname('  Maya  R  '), 'Maya R');
  assert.equal(cleanPetname(''), null);
  assert.equal(cleanPetname('x'.repeat(41)), null);
  assert.equal(cleanPetname(42), null);
});

test('petnames round-trip per author, keys normalized', () => {
  const storage = fakeStorage();
  savePetnames(withPetname(loadPetnames(storage), HEX.toUpperCase(), 'Maya'), storage);
  assert.deepEqual(loadPetnames(storage), { [HEX]: 'Maya' });
});

test('empty name clears the petname', () => {
  assert.deepEqual(withPetname({ [HEX]: 'Maya' }, HEX, ''), {});
  assert.deepEqual(withPetname({ [HEX]: 'Maya' }, HEX, null), {});
});

test('bad keys and names never stick', () => {
  assert.deepEqual(withPetname({}, 'not-hex', 'Maya'), {});
  assert.deepEqual(loadPetnames(fakeStorage({ 'fly.social.petnames': JSON.stringify({ [HEX]: '', nope: 'x' }) })), {});
  assert.deepEqual(loadPetnames(fakeStorage({ 'fly.social.petnames': 'garbage' })), {});
  assert.deepEqual(loadPetnames(null), {});
});

test('duplicate petnames group authors for disambiguation', () => {
  const a = 'aa'.repeat(32);
  const b = 'bb'.repeat(32);
  assert.deepEqual(duplicatePetnames({}), {});
  assert.deepEqual(duplicatePetnames({ [a]: 'Maya', [b]: 'Jon' }), {});
  // Same name, different case, still one collision group with sorted authors.
  // (Label is first-seen spelling; callers only need the author sets.)
  assert.deepEqual(duplicatePetnames({ [b]: 'maya', [a]: 'Maya', [HEX]: 'Jon' }), { maya: [a, b] });
});
