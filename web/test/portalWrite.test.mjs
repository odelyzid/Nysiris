// Run with: node --test web/test
// Portal authoring: signed object id, log-entry signature, and bundle sequencing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPortalLogEntry,
  buildPortalObject,
  buildPortalPublish,
  logEntryRequestJson,
  objectRequestJson,
} from '../src/domain/portalWrite.ts';
import { verifyObjectSig, verifyLogEntrySig } from '../src/domain/portalVerify.ts';
import { verifyPortalObjectId } from '../src/domain/portalSync.ts';
import { PORTAL_KINDS } from '../src/domain/portalContent.ts';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const privateKey = hexToBytes('11'.repeat(32));
const identity = {
  privHex: '11'.repeat(32),
  pubHex: bytesToHex(ed25519.getPublicKey(privateKey)),
};

test('builds an object whose id and signature verify', async () => {
  const object = await buildPortalObject(identity, PORTAL_KINDS.post, {
    version: 1,
    body: 'hello portal',
    replyTo: null,
    attachments: [],
  });
  assert.equal(object.author, identity.pubHex);
  assert.equal(object.kind, 'post');
  assert.equal(await verifyPortalObjectId(object), true);
  assert.equal(verifyObjectSig(object), true);
});

test('builds a valid log entry for the next sequence', async () => {
  const object = await buildPortalObject(identity, PORTAL_KINDS.profile, {
    version: 1,
    name: 'Alice',
    bio: 'hi',
    avatarId: null,
  });
  const entry = buildPortalLogEntry(identity, 0, object.id);
  assert.equal(entry.seq, 0);
  assert.equal(entry.objId, object.id);
  assert.equal(verifyLogEntrySig(entry), true);
  assert.throws(() => buildPortalLogEntry(identity, -1, object.id), /non-negative/);
  assert.throws(() => buildPortalLogEntry(identity, 0, 'nope'), /32 bytes/);
});

test('bundle follows the local replica head', async () => {
  const replica = {
    entriesByAuthor: {
      [identity.pubHex]: [{ author: identity.pubHex, seq: 0, objId: '0'.repeat(64), sig: '0'.repeat(128) }],
    },
    objectsById: {},
  };
  const bundle = await buildPortalPublish(
    identity,
    PORTAL_KINDS.wikiPage,
    { version: 1, slug: 'start', title: 'Start', markdown: '# Start' },
    replica,
  );
  assert.equal(bundle.entry.seq, 1);
  assert.equal(verifyLogEntrySig(bundle.entry), true);
  assert.equal(verifyObjectSig(bundle.object), true);
});

test('wire JSON carries optional PoW and canonical fields', async () => {
  const bundle = await buildPortalPublish(
    identity,
    PORTAL_KINDS.post,
    { version: 1, body: 'hello', replyTo: null, attachments: [] },
    { entriesByAuthor: {}, objectsById: {} },
  );
  const object = objectRequestJson(bundle, { nonce: 7, bits: 4 });
  assert.equal(object.v, 1);
  assert.equal(object.kind, 'post');
  assert.deepEqual(object.pow, { nonce: 7, bits: 4 });
  const entry = logEntryRequestJson(bundle, null);
  assert.equal(entry.seq, 0);
  assert.equal(entry.obj_id, bundle.object.id);
  assert.equal('pow' in entry, false);
});

test('rejects payloads readers would not accept', async () => {
  await assert.rejects(
    buildPortalObject(identity, PORTAL_KINDS.post, { version: 1, body: '', replyTo: null, attachments: [] }),
    /schema/,
  );
  await assert.rejects(buildPortalObject(identity, 'Bad Kind', { version: 1, body: 'x' }), /kind/);
});
