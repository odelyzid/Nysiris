// Run with: node --test web/test
// Post sign/verify round-trip with and without a reply parent, through the
// real noble implementation. Skips cleanly when node_modules are absent
// (offline `./build.sh check`).
import test from 'node:test';
import assert from 'node:assert/strict';

let identity = null;
try {
  identity = await import('../src/application/identityStore.ts');
} catch {
  identity = null;
}

const enc = new TextEncoder();
const DAY = 20400;
const PARENT = 'ab'.repeat(16);

test('top-level post verifies, tampered body does not', { skip: !identity }, () => {
  const id = identity.createIdentity();
  const body = enc.encode('hello mixnet');
  const sig = identity.signPost(id.privHex, id.pubHex, DAY, body);
  assert.equal(identity.verifyPostSignature(id.pubHex, DAY, body, sig), true);
  assert.equal(identity.verifyPostSignature(id.pubHex, DAY, enc.encode('hello mixneT'), sig), false);
});

test('dm-read signature matches the Rust cross-implementation vector', { skip: !identity }, () => {
  // Fixed vector also asserted in crates/social-format/src/sig.rs
  // (verifies_typescript_signed_dm_read): privkey [42; 32], `for` = its
  // derived public key, day = 20400. ed25519 is deterministic, so both
  // sides must produce exactly these bytes.
  const privHex = '42'.repeat(32);
  const forHex = '2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12';
  const sig = identity.signDmRead(privHex, forHex, DAY);
  assert.equal(sig, '38bc9f5a683047cc50f8b13f88d64cf563b40df2d02a72b19c6e76d754c45283ae623751c9c4b2f7333698978fc33a601dca69627287d9c120bebdc7d4fa5d02');
  assert.match(sig, /^[0-9a-f]{128}$/);
});

test('reply parent is bound into the signature', { skip: !identity }, () => {
  const id = identity.createIdentity();
  const body = enc.encode('a reply');
  const sig = identity.signPost(id.privHex, id.pubHex, DAY, body, PARENT);
  assert.equal(identity.verifyPostSignature(id.pubHex, DAY, body, sig, PARENT), true);
  // Parent can't be stripped or swapped.
  assert.equal(identity.verifyPostSignature(id.pubHex, DAY, body, sig), false);
  assert.equal(identity.verifyPostSignature(id.pubHex, DAY, body, sig, 'cd'.repeat(16)), false);
  // Malformed parent never verifies (and never throws).
  assert.equal(identity.verifyPostSignature(id.pubHex, DAY, body, sig, 'zz'), false);
});

test('legacy posts without the parent field still verify', { skip: !identity }, async () => {
  // Simulates a row written before threaded replies: legacy layout
  // domain||author||day_be64||body. The current verifier falls back to it.
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { hexToBytes, bytesToHex } = await import('@noble/hashes/utils.js');
  const id = identity.createIdentity();
  const body = enc.encode('old post');
  const dayBytes = new Uint8Array(8);
  new DataView(dayBytes.buffer).setBigUint64(0, BigInt(DAY));
  const legacy = new Uint8Array([...enc.encode('fly-social-v1/post'), ...hexToBytes(id.pubHex), ...dayBytes, ...body]);
  const sig = bytesToHex(ed25519.sign(legacy, hexToBytes(id.privHex)));
  assert.equal(identity.verifyPostSignature(id.pubHex, DAY, body, sig), true);
});
