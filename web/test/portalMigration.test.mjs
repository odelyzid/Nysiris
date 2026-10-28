// Run with: node --test web/test
// Legacy global replica detection/import into an empty workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_MIGRATION_DISMISSED_KEY,
  dismissLegacyMigration,
  legacyMigrationDismissed,
  legacyReplicaSummary,
  migrateLegacyReplica,
} from '../src/application/portalMigration.ts';
import { MemoryPortalStore } from '../src/application/portalStore.ts';
import { emptyReplica, serializeObject } from '../src/domain/portalSync.ts';

const author = 'a'.repeat(64);
const id = '1'.repeat(64);

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function legacyStorage() {
  const storage = memoryStorage();
  const object = {
    id,
    kind: 'post',
    author,
    payload: new TextEncoder().encode('{"version":1,"body":"x","replyTo":null,"attachments":[]}'),
    sig: '0'.repeat(128),
  };
  storage.setItem(
    'fly.portal.sync.v1',
    JSON.stringify({
      entriesByAuthor: { [author]: [{ author, seq: 0, objId: id, sig: '0'.repeat(128) }] },
      objectsById: { [id]: serializeObject(object) },
    }),
  );
  return storage;
}

test('summarises a legacy replica and the dismissed flag', () => {
  const storage = legacyStorage();
  assert.deepEqual(legacyReplicaSummary(storage), { authors: 1, entries: 1, objects: 1 });
  assert.equal(legacyMigrationDismissed(storage), false);
  dismissLegacyMigration(storage);
  assert.equal(legacyMigrationDismissed(storage), true);
  assert.equal(legacyReplicaSummary(null), null);
});

test('imports only into an empty workspace and clears the old key', async () => {
  const storage = legacyStorage();
  const store = new MemoryPortalStore();
  const result = await migrateLegacyReplica(storage, store, 'nym://a.b@g', emptyReplica());
  assert.equal(result.imported, true);
  assert.equal(result.replica.entriesByAuthor[author].length, 1);
  assert.equal(storage.getItem('fly.portal.sync.v1'), null);
  assert.equal((await store.load('nym://a.b@g')).objectsById[id].kind, 'post');
});

test('refuses to merge into a non-empty workspace', async () => {
  const storage = legacyStorage();
  const store = new MemoryPortalStore();
  const existing = {
    entriesByAuthor: { [author]: [{ author, seq: 0, objId: id, sig: '0'.repeat(128) }] },
    objectsById: {},
  };
  const result = await migrateLegacyReplica(storage, store, 'nym://a.b@g', existing);
  assert.equal(result.imported, false);
  assert.match(result.reason, /already has a replica/);
  assert.equal(await store.load('nym://a.b@g'), null);
});
