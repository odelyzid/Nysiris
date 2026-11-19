// Run with: node --test web/test
// Proof-of-work: byte-compat with the Rust implementation, no dependencies
// (WebCrypto only, so this runs in browsers and Node alike).
import test from 'node:test';
import assert from 'node:assert/strict';
import { leadingZeros, MAX_POW_BITS, payloadHashBytes, provePow, verifyPow } from '../src/mixnet/pow.mjs';

const AUTHOR = new Uint8Array(32).fill(3);

test('proves fast and verifies in one hash', async () => {
  const hash = await payloadHashBytes(new TextEncoder().encode('hello portal'));
  const proof = await provePow(AUTHOR, hash, 8);
  assert.ok(proof && proof.bits === 8);
  assert.equal(await verifyPow(AUTHOR, hash, proof), true);
});

test('proofs bind author and payload', async () => {
  const hash = await payloadHashBytes(new TextEncoder().encode('hello portal'));
  const otherHash = await payloadHashBytes(new TextEncoder().encode('other'));
  const otherAuthor = new Uint8Array(32).fill(4);
  // A proof for one input can, by chance, also satisfy another. Keep proving
  // until we get one that actually discriminates, so the test cannot flake.
  let proof;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    proof = await provePow(AUTHOR, hash, 12);
    assert.ok(proof);
    if (
      !(await verifyPow(otherAuthor, hash, proof)) &&
      !(await verifyPow(AUTHOR, otherHash, proof))
    ) {
      break;
    }
    proof = null;
  }
  assert.ok(proof, 'could not find a discriminating proof');
  assert.equal(await verifyPow(AUTHOR, hash, proof), true);
  assert.equal(await verifyPow(otherAuthor, hash, proof), false);
  assert.equal(await verifyPow(AUTHOR, otherHash, proof), false);
});

test('refuses absurd difficulties and exhaustion', async () => {
  const hash = await payloadHashBytes(new TextEncoder().encode('x'));
  assert.equal(await provePow(AUTHOR, hash, 0), null);
  assert.equal(await provePow(AUTHOR, hash, 99), null);
  assert.equal(await provePow(AUTHOR, hash, 8, { maxAttempts: 0 }), null);
  assert.equal(await verifyPow(AUTHOR, hash, { nonce: 0, bits: 99 }), false);
  assert.equal(await verifyPow(AUTHOR, hash, null), false);
  assert.equal(MAX_POW_BITS, 32);
});

test('leadingZeros counts correctly', () => {
  assert.equal(leadingZeros(new Uint8Array([0x00, 0x00, 0xf0, 0x00])), 16 + 0);
  assert.equal(leadingZeros(new Uint8Array([0x00, 0x10])), 8 + 3);
  assert.equal(leadingZeros(new Uint8Array([0xff])), 0);
});
