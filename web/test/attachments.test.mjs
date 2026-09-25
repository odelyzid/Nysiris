// Run with: node --test web/test
// Validates attachment validation, filename sanitizing, and canonical
// encoding (web/src/domain/attachments.mjs). Dependency-free: runs offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_MIMES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  canonicalAttachmentBytes,
  mimeAllowed,
  parseAttachmentRef,
  parseAttachmentRefs,
  sanitizeFilename,
  validateFile,
} from '../src/domain/attachments.mjs';

test('MIME whitelist admits exactly the seven allowed types', () => {
  assert.deepEqual(
    [...ALLOWED_MIMES],
    ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'text/plain', 'text/markdown', 'application/pdf'],
  );
  assert.equal(mimeAllowed('image/png'), true);
  assert.equal(mimeAllowed('application/octet-stream'), false);
  assert.equal(mimeAllowed('text/html'), false);
  assert.equal(mimeAllowed('IMAGE/PNG'), false);
});

test('validateFile rejects wrong types and oversize files before encryption', () => {
  assert.equal(validateFile('a.png', 'image/png', 100), 'a.png');
  assert.throws(() => validateFile('a.exe', 'application/octet-stream', 100), /not allowed/);
  assert.throws(() => validateFile('big.png', 'image/png', MAX_ATTACHMENT_BYTES), /too large/);
  // Ciphertext overhead (40 bytes) counts: plaintext at the cap minus
  // overhead passes, one byte more fails.
  assert.doesNotThrow(() => validateFile('edge.png', 'image/png', MAX_ATTACHMENT_BYTES - 40));
  assert.throws(() => validateFile('edge.png', 'image/png', MAX_ATTACHMENT_BYTES - 39), /too large/);
});

test('sanitizeFilename strips paths, controls, and truncates', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\Users\\x\\a.png'), 'a.png');
  assert.equal(sanitizeFilename('a\x00b'), 'ab');
  assert.equal(sanitizeFilename(''), 'file');
  assert.equal(sanitizeFilename('..'), 'file');
  const long = `x${'y'.repeat(200)}.png`;
  const clean = sanitizeFilename(long);
  assert.ok([...clean].length <= 80, 'char cap');
  assert.ok(new TextEncoder().encode(clean).length <= 255, 'byte cap');
  // Multibyte truncation never splits a code point.
  const wide = 'ü'.repeat(100);
  assert.doesNotThrow(() => sanitizeFilename(wide));
});

test('parseAttachmentRefs bounds count and fails closed', () => {
  assert.deepEqual(parseAttachmentRefs(undefined), []);
  assert.deepEqual(parseAttachmentRefs(null), []);
  const ref = {
    id: 'ab'.repeat(32),
    name: 'a.png',
    mime: 'image/png',
    size: 10,
    key: 'cd'.repeat(32),
  };
  assert.equal(parseAttachmentRefs([ref]).length, 1);
  assert.throws(() => parseAttachmentRefs('nope'), /array/);
  assert.throws(() => parseAttachmentRefs([ref, ref, ref, ref]), new RegExp(`at most ${MAX_ATTACHMENTS_PER_MESSAGE}`));
  assert.throws(() => parseAttachmentRef({ ...ref, mime: 'text/html' }), /not allowed/);
  assert.throws(() => parseAttachmentRef({ ...ref, id: 'zz' }), /hex/);
  assert.throws(() => parseAttachmentRef({ ...ref, size: MAX_ATTACHMENT_BYTES + 1 }), /too large/);
  // Names are sanitized, not rejected, on the way in.
  assert.equal(parseAttachmentRef({ ...ref, name: '/tmp/x.png' }).name, 'x.png');
});

test('canonical bytes are empty without attachments, stable otherwise', () => {
  assert.equal(canonicalAttachmentBytes([]).length, 0);
  const ref = {
    id: 'ab'.repeat(32),
    name: 'a.png',
    mime: 'image/png',
    size: 10,
    key: 'cd'.repeat(32),
  };
  const a = canonicalAttachmentBytes([ref]);
  const b = canonicalAttachmentBytes([{ ...ref }]);
  assert.deepEqual(a, b);
  // 32 + 1 + 9 + 1 + 5 + 8 + 32 = 88 bytes.
  assert.equal(a.length, 88);
  // Any field change changes the bytes (signature binding).
  for (const mod of [
    { size: 11 },
    { name: 'b.png' },
    { mime: 'image/jpeg' },
    { id: 'ff'.repeat(32) },
    { key: 'ff'.repeat(32) },
  ]) {
    assert.notDeepEqual(a, canonicalAttachmentBytes([{ ...ref, ...mod }]));
  }
});
