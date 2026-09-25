// Run with: node --test web/test
// Pure wire builders for the nysiris-social provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDmRequest, buildPostRequest, buildProfileRequest, b64decode } from '../src/social/api.ts';

const A = 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c';
const SIG = 'ff'.repeat(64);

function json(req) {
  return JSON.parse(new TextDecoder().decode(req.body));
}

test('buildPostRequest omits optional fields when absent', () => {
  const req = buildPostRequest({ author: A, day: 7, body: 'hi', parent: null, refs: [], sig: SIG });
  assert.equal(req.path, '/post');
  assert.deepEqual(json(req), { author: A, day: 7, body: 'hi', sig: SIG });
});

test('buildPostRequest carries parent, refs, and pow when present', () => {
  const refs = [
    { id: 'bb'.repeat(32), name: 'a.png', mime: 'image/png', size: 5, key: 'cc'.repeat(32) },
  ];
  const req = buildPostRequest({
    author: A,
    day: 7,
    body: 'reply',
    parent: 'dd'.repeat(32),
    refs,
    sig: SIG,
    pow: { nonce: 9, bits: 8 },
  });
  assert.deepEqual(json(req), {
    author: A,
    day: 7,
    body: 'reply',
    in_reply_to: 'dd'.repeat(32),
    attachments: refs,
    sig: SIG,
    pow: { nonce: 9, bits: 8 },
  });
});

test('buildProfileRequest matches the provider shape', () => {
  const req = buildProfileRequest({ author: A, name: 'alice', bio: 'hi', day: 3, sig: SIG });
  assert.equal(req.path, '/profile');
  assert.deepEqual(json(req), { author: A, name: 'alice', bio: 'hi', day: 3, sig: SIG });
});

test('buildDmRequest matches the sealed-box wire shape', () => {
  const req = buildDmRequest({ to: A, epubHex: 'ee'.repeat(32), nonceHex: '11'.repeat(24), ciphertextB64: 'aGk=' });
  assert.equal(req.path, '/dm');
  assert.deepEqual(json(req), {
    to: A,
    epub: 'ee'.repeat(32),
    nonce: '11'.repeat(24),
    ciphertext: 'aGk=',
  });
  // b64decode re-export stays usable offline.
  assert.deepEqual(b64decode('aGk='), new Uint8Array([104, 105]));
});