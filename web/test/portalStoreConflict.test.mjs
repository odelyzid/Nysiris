// Run with: node --test web/test
// Conflict classification, manual author reset, and per-portal replica storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPortalSyncError, mergePortalIssues, resetAuthorLog } from '../src/application/portalConflict.ts';
import { MemoryPortalStore, LocalStoragePortalStore, loadPortalMeta, saveScopedReplica } from '../src/application/portalStore.ts';

const authorA = 'a'.repeat(64);
const authorB = 'b'.repeat(64);
const obj1 = '1'.repeat(64);
const obj2 = '2'.repeat(64);

function replica() {
  return {
    entriesByAuthor: {
      [authorA]: [
        { author: authorA, seq: 0, objId: obj1, sig: '1'.repeat(128) },
        { author: authorA, seq: 1, objId: obj2, sig: '2'.repeat(128) },
      ],
      [authorB]: [{ author: authorB, seq: 0, objId: obj1, sig: '3'.repeat(128) }],
    },
    objectsById: {
      [obj1]: { id: obj1, kind: 'post', author: authorA, payload: new Uint8Array([1]), sig: '1'.repeat(128) },
      [obj2]: { id: obj2, kind: 'post', author: authorA, payload: new Uint8Array([2]), sig: '2'.repeat(128) },
    },
  };
}

test('classifies fork, signature, and object failures', () => {
  const fork = classifyPortalSyncError(authorA, new Error('expected seq 2, got 4 (fork or gap)'));
  assert.equal(fork.kind, 'fork');
  assert.equal(fork.expectedSeq, 2);
  assert.equal(fork.gotSeq, 4);
  assert.equal(classifyPortalSyncError(authorA, new Error('bad entry signature')).kind, 'signature');
  assert.equal(classifyPortalSyncError(authorA, new Error('obj deadbeef: bad signature')).kind, 'missing-object');
  assert.equal(mergePortalIssues([fork], [{ ...fork, detail: 'newer' }])[0].detail, 'newer');
});

test('manual reset removes only the author log and orphaned objects', () => {
  const before = replica();
  const reset = resetAuthorLog(before, authorA);
  assert.equal(reset.replica.entriesByAuthor[authorA], undefined);
  assert.equal(reset.replica.entriesByAuthor[authorB].length, 1);
  // obj1 is still referenced by author B, obj2 is not.
  assert.deepEqual(reset.removedObjects, [obj2]);
  assert.ok(reset.replica.objectsById[obj1]);
  assert.equal(reset.replica.objectsById[obj2], undefined);
  assert.deepEqual(resetAuthorLog(before, 'bad'), { replica: before, removedObjects: [] });
});

test('memory and localStorage stores round-trip a replica', async () => {
  const memory = new MemoryPortalStore();
  await memory.save('nym://one@gw', replica());
  const loaded = await memory.load('nym://one@gw');
  assert.equal(loaded.entriesByAuthor[authorA].length, 2);
  assert.deepEqual([...loaded.objectsById[obj1].payload], [1]);
  await memory.clear('nym://one@gw');
  assert.equal(await memory.load('nym://one@gw'), null);

  const map = new Map();
  const storage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
  const local = new LocalStoragePortalStore(storage);
  await local.save('nym://two@gw', replica());
  const loadedLocal = await local.load('nym://two@gw');
  assert.equal(loadedLocal.entriesByAuthor[authorB].length, 1);
  assert.equal(loadPortalMeta(storage).length, 0);
  await saveScopedReplica(local, 'nym://two@gw', replica(), storage);
  const meta = loadPortalMeta(storage);
  assert.equal(meta.length, 1);
  assert.equal(meta[0].scope, 'nym://two@gw');
  assert.equal(meta[0].objects, 2);
});
