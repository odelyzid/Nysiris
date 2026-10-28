// Run with: node --test web/test
// Per-portal author keys: storage isolation, deterministic import, corruption.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPortalAuthor,
  loadPortalAuthor,
  portalAuthorStorageKey,
  removePortalAuthor,
} from '../src/application/portalIdentity.ts';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, value),
  };
}

test('creates and loads a key per portal scope', () => {
  const storage = memoryStorage();
  const secret = '01'.repeat(32);
  const one = createPortalAuthor(storage, 'nym://aaa.bbb@gw', secret);
  const two = createPortalAuthor(storage, 'nym://ccc.ddd@gw', '02'.repeat(32));
  assert.equal(one.privHex, secret);
  assert.notEqual(one.pubHex, two.pubHex);
  assert.deepEqual(loadPortalAuthor(storage, 'nym://aaa.bbb@gw'), one);
  assert.deepEqual(loadPortalAuthor(storage, 'nym://ccc.ddd@gw'), two);
  assert.equal(loadPortalAuthor(storage, 'nym://other@gw'), null);
  assert.notEqual(portalAuthorStorageKey('nym://a@gw'), portalAuthorStorageKey('nym://b@gw'));
});

test('a scope is required and imports validate the secret', () => {
  const storage = memoryStorage();
  assert.throws(() => createPortalAuthor(storage, ''), /scope/);
  assert.throws(() => createPortalAuthor(storage, 'nym://a@gw', 'zz'), /32 bytes/);
  assert.throws(() => createPortalAuthor(storage, 'nym://a@gw', '00'.repeat(31)), /32 bytes/);
});

test('corrupted storage is ignored and removal works', () => {
  const storage = memoryStorage();
  const identity = createPortalAuthor(storage, 'nym://a@gw', '03'.repeat(32));
  storage.setItem(portalAuthorStorageKey('nym://bad@gw'), '{"privHex":"nope"}');
  assert.equal(loadPortalAuthor(storage, 'nym://bad@gw'), null);
  // A mismatched pubkey is rejected rather than trusted.
  storage.setItem(
    portalAuthorStorageKey('nym://wrong@gw'),
    JSON.stringify({ privHex: identity.privHex, pubHex: '00'.repeat(32) }),
  );
  assert.equal(loadPortalAuthor(storage, 'nym://wrong@gw'), null);
  removePortalAuthor(storage, 'nym://a@gw');
  assert.equal(loadPortalAuthor(storage, 'nym://a@gw'), null);
});
