// Run with: node --test web/test
// Invite sign/verify round-trip through the real noble implementation.
// Skips cleanly when node_modules are absent (offline `./build.sh check`).
import test from 'node:test';
import assert from 'node:assert/strict';

let identity = null;
try {
  identity = await import('../src/social/identity.ts');
} catch {
  identity = null;
}

test('invite sign/verify round-trips', { skip: !identity }, () => {
  const id = identity.createIdentity();
  assert.match(id.pubHex, /^[0-9a-f]{64}$/);
  const ADDR = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi.8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR@CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
  const service = `nym://${ADDR}`;
  const invite = identity.signInvite(id.privHex, service, 'join my portal');
  assert.equal(invite.service, service);
  assert.equal(invite.inviter, id.pubHex);
  assert.equal(identity.verifyInvite(invite, service), true);
});

test('invite verification rejects tampering and bait-and-switch', { skip: !identity }, () => {
  const id = identity.createIdentity();
  const ADDR = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi.8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR@CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
  const service = `nym://${ADDR}`;
  const invite = identity.signInvite(id.privHex, service, 'hi');
  assert.equal(identity.verifyInvite({ ...invite, note: 'evil' }, service), false);
  assert.equal(identity.verifyInvite(invite, 'nym://4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi.8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR@AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false);
  assert.equal(identity.verifyInvite({ ...invite, sig: '00'.repeat(64) }, service), false);
  assert.throws(() => identity.signInvite(id.privHex, service, ''));
});

test('invites carry signed vouches; stripping them fails closed', { skip: !identity }, () => {
  const id = identity.createIdentity();
  const ADDR = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi.8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR@CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
  const service = `nym://${ADDR}`;
  const friendA = identity.createIdentity().pubHex;
  const friendB = identity.createIdentity().pubHex;

  const invite = identity.signInvite(id.privHex, service, 'hi', [friendA, friendB]);
  assert.deepEqual(invite.vouches, [friendA, friendB]);
  assert.equal(identity.verifyInvite(invite, service), true);

  // Legacy links (no vouches field) keep verifying.
  const legacy = identity.signInvite(id.privHex, service, 'hi');
  assert.ok(!('vouches' in legacy));
  assert.equal(identity.verifyInvite(legacy, service), true);

  // Stripping vouches breaks the signature: rejected, never downgraded.
  const { vouches, ...stripped } = invite;
  assert.equal(identity.verifyInvite(stripped, service), false);

  // Swapping in another ID breaks the signature too.
  assert.equal(identity.verifyInvite({ ...invite, vouches: [identity.createIdentity().pubHex] }, service), false);

  // Shape defects fail closed without throwing.
  assert.equal(identity.verifyInvite({ ...invite, vouches: ['xyz'] }, service), false);
  assert.equal(identity.verifyInvite({ ...invite, vouches: 'nope' }, service), false);
  assert.equal(
    identity.verifyInvite({ ...invite, vouches: Array.from({ length: 9 }, () => friendA) }, service),
    false,
  );

  // Self-vouch is dropped, duplicates collapse, over-cap throws.
  const self = identity.signInvite(id.privHex, service, 'hi', [id.pubHex, friendA, friendA]);
  assert.deepEqual(self.vouches, [friendA]);
  assert.equal(identity.verifyInvite(self, service), true);
  assert.throws(() =>
    identity.signInvite(id.privHex, service, 'hi', Array.from({ length: 9 }, (_, i) => `${i.toString(16).padStart(2, '0')}`.repeat(32))),
  );
});
