// Run with: node --test web/test
// Verifies the keystore contract (web/src/social/keystore.mjs): detection,
// namespacing, and graceful degradation without a Capacitor runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isKeystoreAvailable, keystoreGet, keystoreRemove, keystoreSet } from '../src/social/keystore.mjs';

function setCapacitor(plugin) {
  if (plugin === undefined) {
    // @ts-expect-error deliberate: simulate a desktop browser
    delete globalThis.Capacitor;
  } else {
    // @ts-expect-error deliberate: test double for the native plugin
    globalThis.Capacitor = { Plugins: { NysirisKeystore: plugin } };
  }
}

test('degrades gracefully without a Capacitor runtime', async () => {
  setCapacitor(undefined);
  assert.equal(isKeystoreAvailable(), false);
  assert.equal(await keystoreGet('social.identity'), null);
  assert.deepEqual(await keystoreSet('social.identity', 'eA=='), { available: false });
  assert.deepEqual(await keystoreRemove('social.identity'), { available: false });
});

test('rejects partial plugin objects', async () => {
  setCapacitor({ get: async () => ({ value: 'eA==' }) });
  assert.equal(isKeystoreAvailable(), false);
  setCapacitor(undefined);
});

test('round-trips through the plugin with namespaced keys', async () => {
  const store = new Map();
  const seen = [];
  setCapacitor({
    get: async ({ key }) => {
      seen.push(['get', key]);
      if (!store.has(key)) throw new Error('not found');
      return { value: store.get(key) };
    },
    set: async ({ key, value }) => {
      seen.push(['set', key]);
      store.set(key, value);
    },
    remove: async ({ key }) => {
      seen.push(['remove', key]);
      store.delete(key);
    },
  });
  try {
    assert.equal(isKeystoreAvailable(), true);
    assert.equal(await keystoreGet('social.identity'), null);
    assert.deepEqual(await keystoreSet('social.identity', 'aGk='), { available: true });
    assert.equal(await keystoreGet('social.identity'), 'aGk=');
    assert.deepEqual(await keystoreRemove('social.identity'), { available: true });
    assert.equal(await keystoreGet('social.identity'), null);
    for (const [, key] of seen) {
      assert.match(key, /^nysiris\//, 'keys are namespaced');
    }
  } finally {
    setCapacitor(undefined);
  }
});

test('empty key names throw', async () => {
  const store = new Map();
  setCapacitor({
    get: async ({ key }) => ({ value: store.get(key) ?? '' }),
    set: async () => {},
    remove: async () => {},
  });
  try {
    await assert.rejects(() => keystoreGet(''));
    await assert.rejects(() => keystoreSet('', 'eA=='));
    await assert.rejects(() => keystoreRemove(''));
  } finally {
    setCapacitor(undefined);
  }
});
