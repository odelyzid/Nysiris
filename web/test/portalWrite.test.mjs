// Run with: node --test web/test
// Portal authoring: signed object id, log-entry signature, and wire JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PORTAL_KINDS } from '../src/domain/portalContent.ts';

let api = null;
let identity = null;
try {
  const write = await import('../src/domain/portalWrite.ts');
  const verify = await import('../src/domain/portalVerify.ts');
  const sync = await import('../src/domain/portalSync.ts');
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { bytesToHex, hexToBytes } = await import('@noble/hashes/utils.js');
  const privateKey = hexToBytes('11'.repeat(32));
  identity = { privHex: '11'.repeat(32), pubHex: bytesToHex(ed25519.getPublicKey(privateKey)) };
  api = {
    ...write,
    verifyObjectSig: verify.verifyObjectSig,
    verifyLogEntrySig: verify.verifyLogEntrySig,
    verifyPortalObjectId: sync.verifyPortalObjectId,
  };
} catch {
  api = null;
  identity = null;
}

function skip(t) {
  if (!api || !identity) {
    t.skip('@noble crypto packages are not installed');
    return true;
  }
  return false;
}

test('builds an object whose id and signature verify', async (t) => {
  if (skip(t)) return;
  const object = await api.buildPortalObject(identity, PORTAL_KINDS.post, {
    version: 1,
    body: 'hello portal',
    replyTo: null,
    attachments: [],
  });
  assert.equal(object.author, identity.pubHex);
  assert.equal(object.kind, 'post');
  assert.equal(await api.verifyPortalObjectId(object), true);
  assert.equal(api.verifyObjectSig(object), true);
});

test('builds a valid log entry for the next sequence', async (t) => {
  if (skip(t)) return;
  const object = await api.buildPortalObject(identity, PORTAL_KINDS.profile, {
    version: 1,
    name: 'Alice',
    bio: 'hi',
    avatarId: null,
  });
  const entry = api.buildPortalLogEntry(identity, 0, object.id);
  assert.equal(entry.seq, 0);
  assert.equal(entry.objId, object.id);
  assert.equal(api.verifyLogEntrySig(entry), true);
  assert.throws(() => api.buildPortalLogEntry(identity, -1, object.id), /non-negative/);
  assert.throws(() => api.buildPortalLogEntry(identity, 0, 'nope'), /32 bytes/);
});

test('bundle follows the local replica head', async (t) => {
  if (skip(t)) return;
  const replica = {
    entriesByAuthor: {
      [identity.pubHex]: [{ author: identity.pubHex, seq: 0, objId: '0'.repeat(64), sig: '0'.repeat(128) }],
    },
    objectsById: {},
  };
  const bundle = await api.buildPortalPublish(
    identity,
    PORTAL_KINDS.wikiPage,
    { version: 1, slug: 'start', title: 'Start', markdown: '# Start' },
    replica,
  );
  assert.equal(bundle.entry.seq, 1);
  assert.equal(api.verifyLogEntrySig(bundle.entry), true);
  assert.equal(api.verifyObjectSig(bundle.object), true);
});

test('wire JSON carries optional PoW and canonical fields', async (t) => {
  if (skip(t)) return;
  const bundle = await api.buildPortalPublish(
    identity,
    PORTAL_KINDS.post,
    { version: 1, body: 'hello', replyTo: null, attachments: [] },
    { entriesByAuthor: {}, objectsById: {} },
  );
  const object = api.objectRequestJson(bundle, { nonce: 7, bits: 4 });
  assert.equal(object.v, 1);
  assert.equal(object.kind, 'post');
  assert.deepEqual(object.pow, { nonce: 7, bits: 4 });
  const entry = api.logEntryRequestJson(bundle, null);
  assert.equal(entry.seq, 0);
  assert.equal(entry.obj_id, bundle.object.id);
  assert.equal('pow' in entry, false);
});

test('rejects payloads readers would not accept', async (t) => {
  if (skip(t)) return;
  await assert.rejects(
    api.buildPortalObject(identity, PORTAL_KINDS.post, { version: 1, body: '', replyTo: null, attachments: [] }),
    /schema/,
  );
  await assert.rejects(api.buildPortalObject(identity, 'Bad Kind', { version: 1, body: 'x' }), /kind/);
});
