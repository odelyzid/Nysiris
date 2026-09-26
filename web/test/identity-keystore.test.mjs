// Run with: node --test web/test
// Identity <-> Android-keystore round-trip: the Java plugin base64-encodes on
// read, so the JS side must decode before parsing (regression test for the
// write-only keystore bug). Skips cleanly when node_modules are absent.
import test from 'node:test';
import assert from 'node:assert/strict';

let identityStore = null;
try {
  identityStore = await import('../src/application/identityStore.ts');
} catch {
  identityStore = null;
}

/** Plugin double mirroring `NysirisKeystorePlugin.java`: values are base64
 *  bytes in both directions; the returned map holds the decoded plaintext
 *  (ciphertext in real life). */
function installBase64Plugin() {
  const store = new Map();
  const enc = (s) => Buffer.from(s, 'utf8').toString('base64');
  const dec = (b) => Buffer.from(b, 'base64').toString('utf8');
  globalThis.Capacitor = {
    Plugins: {
      NysirisKeystore: {
        get: async ({ key }) => {
          if (!store.has(key)) throw new Error('not found');
          return { value: enc(store.get(key)) };
        },
        set: async ({ key, value }) => {
          store.set(key, dec(value));
        },
        remove: async ({ key }) => {
          store.delete(key);
        },
      },
    },
  };
  return store;
}

function removePlugin() {
  // @ts-expect-error deliberate: back to a desktop-browser shape
  delete globalThis.Capacitor;
}

test('identity survives the base64 keystore round-trip', { skip: !identityStore }, async () => {
  const store = installBase64Plugin();
  try {
    const id = identityStore.createIdentity();
    const persisted = await identityStore.persistIdentitySecure(id);
    assert.equal(persisted.keystore, true);
    assert.deepEqual(JSON.parse(store.get('nysiris/social.identity')), id);

    const loaded = await identityStore.loadIdentitySecure();
    assert.deepEqual(loaded, id, 'keystore read must decode base64 before parsing');
  } finally {
    removePlugin();
  }
});

test('migrate reports migrated once the keystore holds the identity', { skip: !identityStore }, async () => {
  const store = installBase64Plugin();
  try {
    const id = identityStore.createIdentity();
    assert.equal(await identityStore.migrateIdentityToKeystore(), 'migrated');
    assert.deepEqual(JSON.parse(store.get('nysiris/social.identity')), id);
    // Second run sees the stored identity instead of re-writing it.
    assert.equal(await identityStore.migrateIdentityToKeystore(), 'migrated');
  } finally {
    removePlugin();
  }
});

test('clearIdentitySecure removes the keystore entry', { skip: !identityStore }, async () => {
  const store = installBase64Plugin();
  try {
    const id = identityStore.createIdentity();
    await identityStore.persistIdentitySecure(id);
    assert.ok(store.has('nysiris/social.identity'));
    await identityStore.clearIdentitySecure();
    assert.equal(store.has('nysiris/social.identity'), false);
  } finally {
    removePlugin();
  }
});

test('garbage in the keystore degrades to the localStorage cache', { skip: !identityStore }, async () => {
  const store = installBase64Plugin();
  try {
    const id = identityStore.createIdentity();
    // Corrupt the stored plaintext (real life: unreadable/mangled ciphertext).
    store.set('nysiris/social.identity', '{"nope":1}');
    const loaded = await identityStore.loadIdentitySecure();
    assert.deepEqual(loaded, id, 'cache fallback after an unreadable keystore');
  } finally {
    removePlugin();
  }
});
