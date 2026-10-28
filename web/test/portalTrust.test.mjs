// Run with: node --test web/test
// Per-portal trust isolation and persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PortalTrustStore,
  loadPortalTrust,
  savePortalTrust,
} from '../src/application/portalTrust.ts';

const a = 'a'.repeat(64);
const b = 'b'.repeat(64);

function memoryStorage() {
  let raw = null;
  return {
    getItem: () => raw,
    setItem: (_key, value) => {
      raw = value;
    },
  };
}

test('verdicts are isolated per portal and default neutral', () => {
  const trust = new PortalTrustStore();
  trust.set('nym://one@gw', a, 'trusted');
  trust.set('nym://one@gw', b, 'blocked');
  assert.equal(trust.get('nym://one@gw', a), 'trusted');
  assert.equal(trust.isTrusted('nym://one@gw', a), true);
  assert.equal(trust.isBlocked('nym://one@gw', b), true);
  assert.equal(trust.get('nym://two@gw', a), 'neutral');
  assert.deepEqual(trust.trustedAuthors('nym://one@gw'), [a]);
  assert.deepEqual(trust.trustedAuthors('nym://two@gw'), []);
});

test('neutral removes an override; clear drops one or all scopes', () => {
  const trust = new PortalTrustStore();
  trust.set('nym://one@gw', a, 'trusted');
  trust.set('nym://one@gw', a, 'neutral');
  assert.equal(trust.size, 0);
  trust.set('nym://one@gw', a, 'trusted');
  trust.set('nym://two@gw', b, 'blocked');
  trust.clear('nym://one@gw');
  assert.equal(trust.size, 1);
  trust.clear();
  assert.equal(trust.size, 0);
});

test('round-trips and drops malformed authors', () => {
  const storage = memoryStorage();
  const trust = new PortalTrustStore();
  trust.set('nym://one@gw', a, 'trusted');
  savePortalTrust(storage, trust);
  assert.equal(loadPortalTrust(storage).get('nym://one@gw', a), 'trusted');

  storage.setItem(
    'fly.portal.trust.v1',
    JSON.stringify({ version: 1, scopes: { 'nym://x@gw': { nope: 'trusted', [a]: 'blocked' } } }),
  );
  const loaded = loadPortalTrust(storage);
  assert.equal(loaded.get('nym://x@gw', a), 'blocked');
  assert.equal(loaded.get('nym://x@gw', 'nope'), 'neutral');
  assert.equal(loadPortalTrust(null).size, 0);
});
