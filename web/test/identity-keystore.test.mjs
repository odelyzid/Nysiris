// Run with: node --test web/test
// Identity <-> Android-keystore round-trip, the wrapped localStorage cache,
// and recovery when the keystore slot is corrupted. The plugin double mirrors
// `NysirisKeystorePlugin.java`: values are base64 bytes in both directions.
// Skips cleanly when node_modules are absent.
import test from 'node:test';
import assert from 'node:assert/strict';

let identityStore = null;
try {
  identityStore = await import('../src/application/identityStore.ts');
} catch {
  identityStore = null;
}

const IDENTITY_KEY = 'nysiris/social.identity';
const WRAP_KEY_SLOT = 'nysiris/social.identity.cache-key';

/** Plugin double mirroring `NysirisKeystorePlugin.java` from the JS side:
 *  base64 in → same base64 out (byte-faithful; the Java side encrypts in
 *  between but never mangles the bytes). */
function installBase64Plugin() {
  const store = new Map();
  globalThis.Capacitor = {
    Plugins: {
      NysirisKeystore: {
        get: async ({ key }) => {
          if (!store.has(key)) throw new Error('not found');
          return { value: store.get(key) };
        },
        set: async ({ key, value }) => {
          store.set(key, value);
        },
        remove: async ({ key }) => {
          store.delete(key);
        },
      },
    },
  };
  return store;
}

/** Plaintext behind a stored base64 slot value. */
function plainAt(store, key) {
  return JSON.parse(Buffer.from(store.get(key), 'base64').toString('utf8'));
}

function removePlugin() {
  // @ts-expect-error deliberate: back to a desktop-browser shape
  delete globalThis.Capacitor;
}

test('keystore round-trip leaves no plaintext identity in the cache', { skip: !identityStore }, async () => {
  const store = installBase64Plugin();
  try {
    const id = identityStore.createIdentity();
    const persisted = await identityStore.persistIdentitySecure(id);
    assert.equal(persisted.keystore, true);
    assert.deepEqual(plainAt(store, IDENTITY_KEY), id, 'keystore slot holds the identity');

    // The sync plaintext reader must NOT see the identity anymore: the cache
    // is token-wrapped, so WebView storage alone never holds privHex.
    assert.equal(identityStore.loadIdentity(), null, 'cache is not plaintext');

    // The async secure path still recovers it.
    const loaded = await identityStore.loadIdentitySecure();
    assert.deepEqual(loaded, id);
  } finally {
    removePlugin();
  }
});

test('migrate reports migrated once the keystore holds the identity', { skip: !identityStore }, async () => {
  const store = installBase64Plugin();
  try {
    const id = identityStore.createIdentity();
    assert.equal(await identityStore.migrateIdentityToKeystore(), 'migrated');
    assert.deepEqual(plainAt(store, IDENTITY_KEY), id);
    // Second run sees the stored identity instead of re-writing it.
    assert.equal(await identityStore.migrateIdentityToKeystore(), 'migrated');
  } finally {
    removePlugin();
  }
});

test('clearIdentitySecure removes the identity, the wrap key, and the cache', { skip: !identityStore }, async () => {
  const store = installBase64Plugin();
  try {
    const id = identityStore.createIdentity();
    await identityStore.persistIdentitySecure(id);
    assert.ok(store.has(IDENTITY_KEY));
    await identityStore.clearIdentitySecure();
    assert.equal(store.has(IDENTITY_KEY), false, 'identity gone from the keystore');
    assert.equal(store.has(WRAP_KEY_SLOT), false, 'wrap key gone (wrapped cache unreadable)');
    assert.equal(await identityStore.loadIdentitySecure(), null);
  } finally {
    removePlugin();
  }
});

test('a corrupted keystore slot is healed from the wrapped cache', { skip: !identityStore }, async () => {
  const store = installBase64Plugin();
  try {
    const id = identityStore.createIdentity();
    await identityStore.persistIdentitySecure(id);
    // Real-life analogue: unreadable/mangled ciphertext in the plugin store.
    store.set(IDENTITY_KEY, Buffer.from('garbage-not-json', 'utf8').toString('base64'));

    const loaded = await identityStore.loadIdentitySecure();
    assert.deepEqual(loaded, id, 'wrapped cache recovers the identity');
    assert.deepEqual(
      plainAt(store, IDENTITY_KEY),
      id,
      'the load heals the keystore slot from the cache',
    );
  } finally {
    removePlugin();
  }
});

test('desktop (no plugin): plaintext cache behaviour is unchanged', { skip: !identityStore }, async () => {
  removePlugin();
  try {
    const id = identityStore.createIdentity();
    const persisted = await identityStore.persistIdentitySecure(id);
    assert.equal(persisted.keystore, false);
    assert.deepEqual(identityStore.loadIdentity(), id, 'sync plaintext path still works');
    assert.deepEqual(await identityStore.loadIdentitySecure(), id);
  } finally {
    removePlugin();
  }
});
