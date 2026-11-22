// Shared DM conformance vectors with the pinned `nysiris-core` submodule.
// Run with: node --test web/test
// The fixture is byte-identical to
// core/crates/nysiris-core/tests/fixtures/dm-v2.json; CI checks both copies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let dm = null;
let ed25519 = null;
let bytes = null;
try {
  dm = await import('../src/application/dm.ts');
  ({ ed25519 } = await import('@noble/curves/ed25519.js'));
  bytes = await import('../src/lib/bytes.ts');
} catch {
  dm = null;
}

const skip = { skip: dm ? false : 'node_modules missing (@noble crypto); run npm ci in web/' };
const { openDm, packDmInnerAt, sealDmWith, unpackDmInner } = dm ?? {};
const { bytesToHex, hexToBytes } = bytes ?? {};

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/nysiris-core-dm-v2.json', import.meta.url), 'utf8'),
);

test('nysiris-core DM vectors are byte-exact in the browser', skip, () => {
  assert.equal(fixture.format, 'nysiris-dm-v2');
  assert.equal(fixture.version, 2);
  assert.equal(fixture.domains.seal, 'fly-social-v1/dm');
  assert.equal(fixture.domains.inner, 'fly-social-v1/dm-inner');

  const recipientPub = bytesToHex(ed25519.getPublicKey(hexToBytes(fixture.recipientPriv)));
  const senderPub = bytesToHex(ed25519.getPublicKey(hexToBytes(fixture.senderPriv)));

  for (const vector of fixture.vectors) {
    const body = hexToBytes(vector.bodyHex);
    // Fixture metadata is a sorted JSON object; the browser writes attachment
    // refs in canonical field order inside the inner envelope.
    const atts = vector.atts.map((a) => ({
      id: a.id,
      name: a.name,
      mime: a.mime,
      size: a.size,
      key: a.key,
    }));
    const innerBytes = new TextEncoder().encode(vector.inner);

    assert.equal(
      packDmInnerAt(fixture.senderPriv, body, atts, fixture.msgId, fixture.ts).json,
      vector.inner,
      `${vector.name}: inner envelope mismatch`,
    );
    const opened = unpackDmInner(vector.inner);
    assert.equal(bytesToHex(opened.body), vector.bodyHex, `${vector.name}: body mismatch`);
    assert.deepEqual(opened.atts, atts, `${vector.name}: attachments mismatch`);
    assert.equal(opened.from, senderPub, `${vector.name}: sender mismatch`);

    const sealed = sealDmWith(
      recipientPub,
      innerBytes,
      fixture.ephemeralPriv,
      fixture.nonceHex,
    );
    assert.deepEqual(sealed, vector.sealed, `${vector.name}: sealed box mismatch`);
    assert.deepEqual(
      openDm(fixture.recipientPriv, vector.sealed),
      innerBytes,
      `${vector.name}: cannot open expected sealed box`,
    );
  }
});

test('a tampered core vector sealed box fails closed', skip, () => {
  const [vector] = fixture.vectors;
  const tampered = {
    ...vector.sealed,
    ciphertextB64: `${vector.sealed.ciphertextB64.slice(0, -2)}AA`,
  };
  assert.throws(() => openDm(fixture.recipientPriv, tampered));
});
