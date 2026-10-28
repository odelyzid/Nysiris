// Run with: node --test web/test
// Per-portal author keys: storage isolation, deterministic import, corruption.
import test from 'node:test';
import assert from 'node:assert/strict';

let portal = null;
try {
  portal = await import('../src/application/portalIdentity.ts');
} catch {
  portal = null;
}

function skip(t) {
  if (!portal) {
    t.skip('@noble crypto packages are not installed');
    return true;
  }
  return false;
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, value),
  };
}

test('creates and loads a key per portal scope', (t) => {
  if (skip(t)) return;
  const storage = memoryStorage();
  const secret = '01'.repeat(32);
  const one = portal.createPortalAuthor(storage, 'nym://aaa.bbb@gw', secret);
  const two = portal.createPortalAuthor(storage, 'nym://ccc.ddd@gw', '02'.repeat(32));
  assert.equal(one.privHex, secret);
  assert.notEqual(one.pubHex, two.pubHex);
  assert.deepEqual(portal.loadPortalAuthor(storage, 'nym://aaa.bbb@gw'), one);
  assert.deepEqual(portal.loadPortalAuthor(storage, 'nym://ccc.ddd@gw'), two);
  assert.equal(portal.loadPortalAuthor(storage, 'nym://other@gw'), null);
  assert.notEqual(portal.portalAuthorStorageKey('nym://a@gw'), portal.portalAuthorStorageKey('nym://b@gw'));
});

test('a scope is required and imports validate the secret', (t) => {
  if (skip(t)) return;
  const storage = memoryStorage();
  assert.throws(() => portal.createPortalAuthor(storage, ''), /scope/);
  assert.throws(() => portal.createPortalAuthor(storage, 'nym://a@gw', 'zz'), /32 bytes/);
  assert.throws(() => portal.createPortalAuthor(storage, 'nym://a@gw', '00'.repeat(31)), /32 bytes/);
});

test('corrupted storage is ignored and removal works', (t) => {
  if (skip(t)) return;
  const storage = memoryStorage();
  const identity = portal.createPortalAuthor(storage, 'nym://a@gw', '03'.repeat(32));
  storage.setItem(portal.portalAuthorStorageKey('nym://bad@gw'), '{"privHex":"nope"}');
  assert.equal(portal.loadPortalAuthor(storage, 'nym://bad@gw'), null);
  // A mismatched pubkey is rejected rather than trusted.
  storage.setItem(
    portal.portalAuthorStorageKey('nym://wrong@gw'),
    JSON.stringify({ privHex: identity.privHex, pubHex: '00'.repeat(32) }),
  );
  assert.equal(portal.loadPortalAuthor(storage, 'nym://wrong@gw'), null);
  portal.removePortalAuthor(storage, 'nym://a@gw');
  assert.equal(portal.loadPortalAuthor(storage, 'nym://a@gw'), null);
});
