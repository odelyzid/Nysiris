// Run with: node --test web/test
// Signed 1:1 inner envelope over the sealed-box transport. Skips cleanly
// when the noble packages are not installed (offline `./build.sh check`).
import test from 'node:test';
import assert from 'node:assert/strict';

let dm = null;
let ed25519 = null;
try {
  dm = await import('../src/social/dm.ts');
  ({ ed25519 } = await import('@noble/curves/ed25519.js'));
} catch {
  dm = null;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function keypair() {
  const priv = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(priv);
  const hex = [...pub].map((b) => b.toString(16).padStart(2, '0')).join('');
  const privHex = [...priv].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { privHex, pubHex: hex };
}

function goodAttRef() {
  return {
    id: 'ab'.repeat(32),
    name: 'a.png',
    mime: 'image/png',
    size: 10,
    key: 'cd'.repeat(32),
  };
}

test('inner envelope round-trips through the sealed box with attribution', { skip: !dm }, () => {
  const alice = keypair();
  const bob = keypair();

  // Alice packs (signed) then seals to Bob's pubkey.
  const packed = dm.packDmInner(alice.privHex, enc.encode('hello bob'));
  assert.match(packed.msgId, /^[0-9a-f]{32}$/);
  const sealed = dm.sealDm(bob.pubHex, enc.encode(packed.json));

  // The sealed box leaks nothing of the plaintext or the sender.
  assert.ok(!sealed.ciphertextB64.includes('hello'));
  assert.ok(!JSON.stringify(sealed).includes(alice.pubHex.slice(0, 16)));

  // Bob opens then verifies: sender attributed, body exact, id stable.
  const inner = dm.unpackDmInner(dec.decode(dm.openDm(bob.privHex, sealed)));
  assert.equal(inner.from, alice.pubHex);
  assert.equal(inner.msgId, packed.msgId);
  assert.equal(dec.decode(inner.body), 'hello bob');
  assert.ok(Number.isInteger(inner.ts) && inner.ts > 0);
});

test('tampered inner envelopes are rejected', { skip: !dm }, () => {
  const alice = keypair();
  const bob = keypair();
  const packed = dm.packDmInner(alice.privHex, enc.encode('meet at dawn'));
  const sealed = dm.sealDm(bob.pubHex, enc.encode(packed.json));
  const raw = dec.decode(dm.openDm(bob.privHex, sealed));

  // Flip the body without re-signing.
  const tamperedBody = { ...JSON.parse(raw), bodyB64: Buffer.from('forged').toString('base64') };
  assert.throws(() => dm.unpackDmInner(JSON.stringify(tamperedBody)), /signature invalid/);

  // Swap the sender without re-signing.
  const mallory = keypair();
  const tamperedFrom = { ...JSON.parse(raw), from: mallory.pubHex };
  assert.throws(() => dm.unpackDmInner(JSON.stringify(tamperedFrom)), /signature invalid/);

  // A signature from another key does not verify.
  const other = { ...JSON.parse(raw), sig: 'ab'.repeat(64) };
  assert.throws(() => dm.unpackDmInner(JSON.stringify(other)), /signature invalid/);
});

test('malformed inner envelopes are rejected', { skip: !dm }, () => {
  const alice = keypair();
  const good = JSON.parse(dm.packDmInner(alice.privHex, enc.encode('hi')).json);
  const cases = [
    ['not json', 'not JSON'],
    [[], 'must be an object'],
    [{ ...good, v: 3 }, 'unsupported DM inner version'],
    [{ ...good, v: 0 }, 'unsupported DM inner version'],
    [{ ...good, from: 'xyz' }, 'bad sender'],
    [{ ...good, ts: -1 }, 'bad timestamp'],
    [{ ...good, msgId: 'short' }, 'bad id'],
    [{ ...good, bodyB64: 42 }, 'no body'],
    [{ ...good, bodyB64: '!!!' }, 'not base64'],
    [{ ...good, sig: 'zz' }, 'bad signature'],
    [{ ...good, sig: undefined }, 'bad signature'],
    [{ ...good, atts: 'nope' }, 'bad attachments'],
    [{ ...good, atts: [{ ...goodAttRef(), mime: 'text/html' }] }, 'bad attachments'],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(
      () => dm.unpackDmInner(typeof input === 'string' ? input : JSON.stringify(input)),
      new RegExp(pattern),
    );
  }
});

test('v2 inner envelope carries attachments under the signature', { skip: !dm }, () => {
  const alice = keypair();
  const atts = [goodAttRef()];
  const packed = dm.packDmInner(alice.privHex, enc.encode('with files'), atts);
  const inner = dm.unpackDmInner(packed.json);
  assert.deepEqual(inner.atts, atts);

  // Stripping the refs breaks the signature…
  const stripped = { ...JSON.parse(packed.json) };
  delete stripped.atts;
  assert.throws(() => dm.unpackDmInner(JSON.stringify(stripped)), /signature invalid/);

  // …as does swapping one.
  const swapped = { ...JSON.parse(packed.json) };
  swapped.atts = [{ ...goodAttRef(), id: 'ff'.repeat(32) }];
  assert.throws(() => dm.unpackDmInner(JSON.stringify(swapped)), /signature invalid/);
});

test('message ids are unique per pack', { skip: !dm }, () => {
  const alice = keypair();
  const ids = new Set();
  for (let i = 0; i < 50; i += 1) ids.add(dm.packDmInner(alice.privHex, enc.encode(`m${i}`)).msgId);
  assert.equal(ids.size, 50);
});
