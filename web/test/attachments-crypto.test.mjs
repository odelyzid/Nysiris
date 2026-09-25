// Run with: node --test web/test
// Round-trip of the attachment envelope encryption (web/src/domain/
// attachmentCrypto.ts). Skips cleanly when the noble packages are not installed
// (offline `./build.sh check`).
import test from 'node:test';
import assert from 'node:assert/strict';

let attach = null;
let noble = null;
try {
  attach = await import('../src/domain/attachmentCrypto.ts');
  const utils = await import('@noble/hashes/utils.js');
  noble = { ...utils };
} catch {
  attach = null;
}

const enc = new TextEncoder();

test('encrypt/decrypt round-trips and binds the content address', async (t) => {
  if (!attach) return t.skip('noble not installed');
  const plain = enc.encode('small secret file');
  const p = await attach.encryptAttachment('note.md', 'text/markdown', plain);
  assert.equal(p.size, plain.length);
  assert.equal(p.mime, 'text/markdown');
  assert.match(p.id, /^[0-9a-f]{64}$/);
  assert.match(p.key, /^[0-9a-f]{64}$/);
  // Blob layout: nonce(24) || ct; id is SHA256(blob).
  assert.equal(p.blob.length, plain.length + 40);
  assert.equal(await attach.blobId(p.blob), p.id);
  const back = await attach.decryptAttachment(p, p.blob);
  assert.deepEqual(back, plain);
});

test('encryption is randomised and tamper-evident', async (t) => {
  if (!attach) return t.skip('noble not installed');
  const plain = enc.encode('same bytes');
  const a = await attach.encryptAttachment('a.txt', 'text/plain', plain);
  const b = await attach.encryptAttachment('a.txt', 'text/plain', plain);
  assert.notDeepEqual(a.blob, b.blob, 'fresh key+nonce every time');
  assert.notEqual(a.id, b.id);

  const tampered = Uint8Array.from(a.blob);
  tampered[tampered.length - 1] ^= 0x01;
  await assert.rejects(() => attach.decryptAttachment(a, tampered), /unavailable/);

  // Wrong content address: rejected before decryption.
  const wrong = { ...a, id: 'ff'.repeat(32) };
  await assert.rejects(() => attach.decryptAttachment(wrong, a.blob), /unavailable/);

  // Wrong key: GCM tag fails, surfaced as unavailable.
  const wrongKey = { ...a, key: '00'.repeat(32) };
  await assert.rejects(() => attach.decryptAttachment(wrongKey, a.blob), /unavailable/);
});

test('oversize plaintext is refused before encryption', async (t) => {
  if (!attach) return t.skip('noble not installed');
  const { MAX_ATTACHMENT_BYTES, ATTACHMENT_OVERHEAD_BYTES } = attach;
  const ok = new Uint8Array(MAX_ATTACHMENT_BYTES - ATTACHMENT_OVERHEAD_BYTES);
  const tooBig = new Uint8Array(MAX_ATTACHMENT_BYTES - ATTACHMENT_OVERHEAD_BYTES + 1);
  await assert.doesNotReject(attach.encryptAttachment('ok.bin', 'text/plain', ok));
  await assert.rejects(attach.encryptAttachment('big.bin', 'text/plain', tooBig), /too large/);
});

test('TypeScript canonical bytes match the byte layout', async (t) => {
  if (!attach) return t.skip('noble not installed');
  const { canonicalAttachmentBytes } = await import('../src/domain/attachments.mjs');
  const ref = {
    id: 'ab'.repeat(32),
    name: 'a.png',
    mime: 'image/png',
    size: 10,
    key: 'cd'.repeat(32),
  };
  const bytes = canonicalAttachmentBytes([ref]);
  // id(32) || mime_len(1)=9 || mime(9) || name_len(1)=5 || name(5) ||
  // size_be64(8)=10 || key(32).
  assert.equal(bytes.length, 88);
  assert.deepEqual(bytes.slice(0, 2), Uint8Array.from([0xab, 0xab]));
  assert.equal(bytes[32], 9);
  assert.equal(new TextDecoder().decode(bytes.slice(33, 42)), 'image/png');
  assert.equal(bytes[42], 5);
  assert.equal(new TextDecoder().decode(bytes.slice(43, 48)), 'a.png');
  assert.equal(new DataView(bytes.buffer).getBigUint64(48), 10n);
  assert.deepEqual(bytes.slice(56, 58), Uint8Array.from([0xcd, 0xcd]));
});
