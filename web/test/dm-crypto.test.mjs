// Run with: node --test web/test
// E2E round-trip of the DM construction. Skips cleanly when the noble
// packages are not installed (offline `./build.sh check`).
import test from 'node:test';
import assert from 'node:assert/strict';

let noble = null;
try {
  const [curves, hashes, ciphers] = await Promise.all([
    import('@noble/curves/ed25519.js'),
    import('@noble/hashes/utils.js'),
    import('@noble/ciphers/chacha.js'),
  ]);
  const [{ blake2b }] = [await import('@noble/hashes/blake2.js')];
  noble = { ...curves, ...hashes, ...ciphers, blake2b };
} catch {
  noble = null;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function kdf(shared) {
  const dom = enc.encode('fly-social-v1/dm');
  const input = new Uint8Array(dom.length + shared.length);
  input.set(dom, 0);
  input.set(shared, dom.length);
  return noble.blake2b(input, { dkLen: 32 });
}

test('DM seal/open round-trips and is anonymous to the server', { skip: !noble }, () => {
  const { ed25519, x25519, xchacha20poly1305, randomBytes, bytesToHex } = noble;
  const alicePriv = ed25519.utils.randomSecretKey();
  const bobPriv = ed25519.utils.randomSecretKey();
  const bobPub = ed25519.getPublicKey(bobPriv);

  // Seal (sender side, knows only Bob's ed pubkey).
  const eph = x25519.utils.randomSecretKey();
  const shared = x25519.getSharedSecret(eph, ed25519.utils.toMontgomery(bobPub));
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(kdf(shared), nonce).encrypt(enc.encode('meet at dawn'));

  // Server sees only opaque blobs.
  const stored = { epub: bytesToHex(x25519.getPublicKey(eph)), ct: Buffer.from(ct).toString('base64') };
  assert.ok(!JSON.stringify(stored).includes('dawn'));

  // Open (receiver side).
  const shared2 = x25519.getSharedSecret(
    ed25519.utils.toMontgomerySecret(bobPriv),
    Uint8Array.from(Buffer.from(stored.epub, 'hex')),
  );
  const pt = xchacha20poly1305(kdf(shared2), nonce).decrypt(Uint8Array.from(Buffer.from(stored.ct, 'base64')));
  assert.equal(dec.decode(pt), 'meet at dawn');

  // Wrong key fails.
  assert.throws(() =>
    xchacha20poly1305(
      kdf(x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(alicePriv), Uint8Array.from(Buffer.from(stored.epub, 'hex')))),
      nonce,
    ).decrypt(Uint8Array.from(Buffer.from(stored.ct, 'base64'))),
  );
});
