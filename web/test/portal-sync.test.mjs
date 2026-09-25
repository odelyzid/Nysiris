// Run with: node --test web/test
// Browser TS port of portal replication: golden wire vectors mirrored from
// crates/portal-replication/tests/golden.rs, plus structural diff/merge/
// persistence/id-verify tests. Everything runs offline except the ed25519
// signature check, which uses the @noble dynamic-import skip pattern.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOG_ENTRY_DOMAIN,
  MAX_KEPT_OBJECTS,
  MAX_OBJECT_BYTES,
  OBJECT_DOMAIN,
  PORTAL_SYNC_KEY,
  describePortalSync,
  diffPortalWants,
  emptyReplica,
  loadPortalReplica,
  mergePortalEntries,
  parsePortalHeadsReply,
  parsePortalLogReply,
  parsePortalObjectReply,
  portalEntryBytes,
  portalHeads,
  portalObjectSigningBytes,
  savePortalReplica,
  trimReplica,
  verifyPortalObjectId,
} from '../src/social/portalSync.ts';
import { bytesToHex, hexToBytes, u64be } from '../src/lib/bytes.ts';

// Golden vectors (byte-exact strings from tests/golden.rs — do not rename).
const ALICE = 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c';
const BOB = '1398f62c6d1a457c51ba6a4b5f3dbd2f69fca93216218dc8997e416bd17d93ca';
const CAROL = 'c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9';
const OBJ = '07'.repeat(32);
const SIG0 =
  'ffc87d3e2874b24edee845705c4982d1a9ac983e4b63efeedfadf7050189541a80ecce309ad055301255c965d78bf2f82dbf3672c944d4d3e3722a7f0f88d307';
const SIG1 =
  '58263ef4759523de28395fa6636622d82e8f622aa5244b56827fdd525bbfd93f0b48cc33c7ede0d1459b3c1b0e5fc7501bf164445a3f1ef39dc74938187a0606';

const enc = new TextEncoder();

// The @noble signature check only runs when node_modules are installed.
let noble = false;
try {
  await import('@noble/curves/ed25519.js');
  noble = true;
} catch {
  noble = false;
}

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

test('golden heads reply parses to the canonical map', () => {
  const json = JSON.parse(`{"heads":[{"author":"${ALICE}","seq":3},{"author":"${BOB}","seq":1}]}`);
  assert.deepEqual(parsePortalHeadsReply(json), { [ALICE]: 3, [BOB]: 1 });
});

test('golden log reply parses byte-exact', () => {
  const json = JSON.parse(
    `{"entries":[{"author":"${ALICE}","obj_id":"${OBJ}","seq":0,"sig":"${SIG0}"},{"author":"${ALICE}","obj_id":"${OBJ}","seq":1,"sig":"${SIG1}"}],"head":2}`,
  );
  const { entries, head } = parsePortalLogReply(json, 0);
  assert.equal(head, 2);
  assert.deepEqual(entries, [
    { author: ALICE, seq: 0, objId: OBJ, sig: SIG0 },
    { author: ALICE, seq: 1, objId: OBJ, sig: SIG1 },
  ]);
});

test('golden SIG0 verifies over entry bytes (needs node_modules)', { skip: !noble }, async () => {
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { verifyLogEntrySig, verifyObjectSig } = await import('../src/social/portalVerify.ts');
  const msg = portalEntryBytes(ALICE, 0, OBJ);
  assert.equal(ed25519.verify(hexToBytes(SIG0), msg, hexToBytes(ALICE)), true);
  // Wrong seq breaks the message coverage.
  assert.equal(ed25519.verify(hexToBytes(SIG0), portalEntryBytes(ALICE, 1, OBJ), hexToBytes(ALICE)), false);
  // The browser verifier itself accepts the golden entry and rejects a forged one.
  assert.equal(verifyLogEntrySig({ author: ALICE, seq: 0, objId: OBJ, sig: SIG0 }), true);
  assert.equal(verifyLogEntrySig({ author: ALICE, seq: 1, objId: OBJ, sig: SIG0 }), false);
  // Object signature path: sign the object signing bytes, then verify.
  const secret = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(secret);
  const author = bytesToHex(pub);
  const payload = enc.encode('hello portal object');
  const signing = portalObjectSigningBytes(author, 'post', payload);
  const objSig = bytesToHex(ed25519.sign(signing, secret));
  const obj = { id: '00'.repeat(32), kind: 'post', author, payload, sig: objSig };
  assert.equal(verifyObjectSig(obj), true);
  assert.equal(verifyObjectSig({ ...obj, payload: enc.encode('tampered') }), false);
  assert.equal(verifyObjectSig({ ...obj, sig: 'ff'.repeat(64) }), false);
});

test('entry bytes are the exact wire layout', () => {
  const bytes = portalEntryBytes(ALICE, 7, OBJ);
  assert.equal(bytes.length, enc.encode(LOG_ENTRY_DOMAIN).length + 32 + 8 + 32);
  assert.equal(bytesToHex(bytes.subarray(0, enc.encode(LOG_ENTRY_DOMAIN).length)), bytesToHex(enc.encode(LOG_ENTRY_DOMAIN)));
  assert.equal(bytesToHex(bytes.subarray(enc.encode(LOG_ENTRY_DOMAIN).length, enc.encode(LOG_ENTRY_DOMAIN).length + 32)), ALICE);
  const seqBytes = bytes.subarray(enc.encode(LOG_ENTRY_DOMAIN).length + 32, enc.encode(LOG_ENTRY_DOMAIN).length + 40);
  assert.deepEqual(seqBytes, u64be(7));
});

test('log reply rejects gaps, mixed seq starts, and bad hex', () => {
  const base = `{"entries":[{"author":"${ALICE}","obj_id":"${OBJ}","seq":0,"sig":"${SIG0}"}],"head":1}`;
  // Expected first seq differs from what a want computed.
  assert.throws(() => parsePortalLogReply(JSON.parse(base), 1), /expected first seq 1, got 0/);
  // Non-hex author.
  assert.throws(
    () => parsePortalLogReply(JSON.parse(`{"entries":[{"author":"zz${ALICE.slice(2)}","obj_id":"${OBJ}","seq":0,"sig":"${SIG0}"}],"head":1}`), 0),
    /must be 32 bytes hex/,
  );
  // Descending seq.
  const dup = `{"entries":[{"author":"${ALICE}","obj_id":"${OBJ}","seq":1,"sig":"${SIG1}"},{"author":"${ALICE}","obj_id":"${OBJ}","seq":0,"sig":"${SIG0}"}],"head":2}`;
  assert.throws(() => parsePortalLogReply(JSON.parse(dup), 1), /strictly ascending/);
  // Malformed root.
  assert.throws(() => parsePortalLogReply({}, 0), /entries/);
});

test('diff computes wants sorted by author, omitting leads', () => {
  assert.deepEqual(diffPortalWants({ [BOB]: 2 }, { [ALICE]: 3, [BOB]: 1, [CAROL]: 4 }), [
    { author: CAROL, fromSeq: 0 },
    { author: ALICE, fromSeq: 0 },
  ]);
  assert.deepEqual(diffPortalWants({ [ALICE]: 3 }, { [ALICE]: 3 }), []);
  assert.deepEqual(diffPortalWants({}, {}), []);
});

test('merge applies an author batch atomically with continuity + verify', async () => {
  const a1 = { author: ALICE, seq: 0, objId: OBJ, sig: SIG0 };
  const a2 = { author: ALICE, seq: 1, objId: OBJ, sig: SIG1 };
  const memo = { [ALICE]: [a1, a2] };
  const verify = (e) => memo[e.author]?.find((x) => x.seq === e.seq)?.sig === e.sig;

  const first = await mergePortalEntries(emptyReplica(), [a1], verify);
  assert.equal(first.applied, 1);
  assert.deepEqual(first.replica.entriesByAuthor[ALICE], [a1]);
  assert.deepEqual(portalHeads(first.replica), { [ALICE]: 1 });

  const second = await mergePortalEntries(first.replica, [a2], verify);
  assert.equal(second.applied, 1);
  assert.deepEqual(second.replica.entriesByAuthor[ALICE], [a1, a2]);
  assert.deepEqual(portalHeads(second.replica), { [ALICE]: 2 });
});

test('merge rejects a gap, a fork, mixed authors, and bad signature — atomically', async () => {
  const base = { [ALICE]: [{ author: ALICE, seq: 0, objId: OBJ, sig: SIG0 }] };
  const replica = { entriesByAuthor: base, objectsById: {} };
  const ok = () => true;

  // Gap: next seq must be 1.
  await assert.rejects(mergePortalEntries(replica, [{ author: ALICE, seq: 5, objId: OBJ, sig: SIG0 }], ok), /fork or gap/);
  // Mixed authors (first entry must clear continuity before the mismatch fires).
  await assert.rejects(
    mergePortalEntries(
      replica,
      [
        { author: BOB, seq: 0, objId: OBJ, sig: SIG0 },
        { author: ALICE, seq: 2, objId: OBJ, sig: SIG0 },
      ],
      ok,
    ),
    /mixes authors/,
  );
  // Nothing landed on any defect.
  assert.deepEqual(replica, { entriesByAuthor: base, objectsById: {} });
  // Forged signature.
  const forged = { author: ALICE, seq: 1, objId: OBJ, sig: 'ff'.repeat(64) };
  await assert.rejects(mergePortalEntries(replica, [forged], (e) => e.sig === SIG1), /bad entry signature/);
  // Empty batch applies nothing.
  const empty = await mergePortalEntries(replica, [], ok);
  assert.equal(empty.applied, 0);
  assert.deepEqual(empty.replica.entriesByAuthor, base);
});

test('object reply parsing validates kind, hex, and payload shape', () => {
  const good = {
    id: '10'.repeat(32),
    kind: 'post',
    author: ALICE,
    payload: Buffer.from('hello').toString('base64'),
    sig: '20'.repeat(64),
  };
  const obj = parsePortalObjectReply(good);
  assert.equal(obj.id, '10'.repeat(32));
  assert.deepEqual(obj.payload, enc.encode('hello'));
  // Unknown kinds are storable but harmless.
  assert.equal(parsePortalObjectReply({ ...good, kind: 'dm-chunk' }).kind, 'dm-chunk');
  // Bad kind charset.
  assert.throws(() => parsePortalObjectReply({ ...good, kind: 'Post!Kind' }), /chars of/);
  // Oversized payload: anything at or over the byte cap is rejected.
  assert.throws(
    () => parsePortalObjectReply({ ...good, payload: Buffer.alloc(MAX_OBJECT_BYTES + 1).toString('base64') }),
    /size cap/,
  );
  // Short sig.
  assert.throws(() => parsePortalObjectReply({ ...good, sig: 'ab' }), /must be 64 bytes hex/);
});

test('object content id is recomputed and self-checks (offline sha256)', async () => {
  const sigBytes = new Uint8Array(64).fill(0x11);
  const payload = enc.encode('hello portal');
  const signing = portalObjectSigningBytes(ALICE, 'post', payload);
  // Signing bytes start with the frozen object domain.
  assert.equal(new TextDecoder().decode(signing.subarray(0, OBJECT_DOMAIN.length)), OBJECT_DOMAIN);
  const toHash = new Uint8Array(signing.length + 64);
  toHash.set(signing, 0);
  toHash.set(sigBytes, signing.length);
  const id = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', toHash)));
  const obj = { id, kind: 'post', author: ALICE, payload, sig: '11'.repeat(64) };
  assert.equal(await verifyPortalObjectId(obj), true);
  // Tamper the payload → the claimed id no longer matches.
  const tampered = { ...obj, payload: enc.encode('hello poral') };
  assert.equal(await verifyPortalObjectId(tampered), false);
  // Tampered sig bytes → id mismatch.
  assert.equal(await verifyPortalObjectId({ ...obj, sig: '22'.repeat(64) }), false);
});

test('replica persists under the frozen key and heals on corruption', () => {
  const storage = fakeStorage();
  const replica = {
    entriesByAuthor: { [ALICE]: [{ author: ALICE, seq: 0, objId: OBJ, sig: SIG0 }] },
    objectsById: { [OBJ]: { id: OBJ, kind: 'post', author: ALICE, payload: enc.encode('x'), sig: SIG0 } },
  };
  savePortalReplica(replica, storage);
  assert.ok(String(storage.getItem(PORTAL_SYNC_KEY)).length > 0);
  assert.deepEqual(loadPortalReplica(storage), replica);
  // Corrupted data → empty replica, never a crash.
  storage.setItem(PORTAL_SYNC_KEY, '{oops');
  assert.deepEqual(loadPortalReplica(storage), emptyReplica());
  assert.deepEqual(loadPortalReplica(null), emptyReplica());
  // A malformed persisted log is dropped whole (fail closed), not trusted.
  storage.setItem(
    PORTAL_SYNC_KEY,
    JSON.stringify({
      entriesByAuthor: {
        [ALICE]: [
          { author: ALICE, seq: 0, objId: OBJ, sig: SIG0 },
          { author: BOB, seq: 1, objId: OBJ, sig: SIG0 },
        ],
        [BOB]: [{ author: BOB, seq: 0, objId: OBJ, sig: SIG0 }],
      },
      objectsById: { [OBJ]: { id: OBJ, kind: 'post', author: ALICE, payload: 'eA==', sig: SIG0 } },
    }),
  );
  const healed = loadPortalReplica(storage);
  assert.deepEqual(healed.entriesByAuthor, { [BOB]: [{ author: BOB, seq: 0, objId: OBJ, sig: SIG0 }] });
  assert.deepEqual(Object.keys(healed.objectsById), [OBJ]);
});

test('trim removes the smallest author first until the object cap fits', () => {
  const aObj = { id: 'aa'.repeat(32), kind: 'post', author: ALICE, payload: enc.encode('a'), sig: SIG0 };
  const b1 = { id: 'b1'.repeat(32), kind: 'post', author: BOB, payload: enc.encode('b'), sig: SIG1 };
  const b2 = { id: 'b2'.repeat(32), kind: 'post', author: BOB, payload: enc.encode('c'), sig: SIG0 };
  const replica = {
    entriesByAuthor: {
      [ALICE]: [{ author: ALICE, seq: 0, objId: aObj.id, sig: SIG0 }],
      [BOB]: [
        { author: BOB, seq: 0, objId: b1.id, sig: SIG1 },
        { author: BOB, seq: 1, objId: b2.id, sig: SIG1 },
      ],
    },
    objectsById: { [aObj.id]: aObj, [b1.id]: b1, [b2.id]: b2 },
  };
  const trimmed = trimReplica(replica, 2);
  assert.deepEqual(Object.keys(trimmed.objectsById).sort(), [b1.id, b2.id].sort());
  assert.deepEqual(trimmed.entriesByAuthor, { [BOB]: replica.entriesByAuthor[BOB] });
});

test('describePortalSync picks the right tone per state', () => {
  assert.equal(describePortalSync(1_000, { syncing: true, lastSyncedAt: null, error: null }).tone, 'busy');
  assert.equal(describePortalSync(1_000, { syncing: false, lastSyncedAt: null, error: 'boom' }).tone, 'bad');
  assert.equal(describePortalSync(1_000, { syncing: false, lastSyncedAt: null, error: null }).tone, 'idle');
  assert.equal(describePortalSync(1_000, { syncing: false, lastSyncedAt: 500, error: null }).tone, 'ok');
  assert.equal(describePortalSync(70_000, { syncing: false, lastSyncedAt: 10_000, error: null }).tone, 'ok');
});