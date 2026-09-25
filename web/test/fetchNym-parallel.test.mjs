// Run with: node --test web/test
// Verifies parallel reply dispatch (fetchNym.ts `dispatchReply`): tagged
// replies only resolve registered waiters, untagged replies go to the serial
// waiter, garbage is dropped. Skips cleanly without node_modules (the module
// imports the messaging stack).
import test from 'node:test';
import assert from 'node:assert/strict';

let dispatchReply = null;
try {
  ({ dispatchReply } = await import('../src/mixnet/hiddenService.mjs'));
} catch {
  dispatchReply = null;
}

const reply = (tag) =>
  JSON.stringify({ status: 200, headers: {}, body_base64: '', error: null, ...(tag ? { tag } : {}) });

test('tagged replies route by tag, never to the serial waiter', async (t) => {
  if (!dispatchReply) return t.skip('messaging stack not installed');
  const got = [];
  const parallel = new Map([
    ['p1', (text) => got.push(['p1', text])],
    ['p2', (text) => got.push(['p2', text])],
  ]);
  const serial = (text) => got.push(['serial', text]);

  // Out of order delivery still matches correctly.
  dispatchReply(reply('p2'), parallel, serial);
  dispatchReply(reply('p1'), parallel, serial);
  assert.deepEqual(
    got.map(([k]) => k),
    ['p2', 'p1'],
  );

  // Unknown tag: dropped, resolves nothing.
  dispatchReply(reply('p9'), parallel, serial);
  // Untagged reply: goes to the serial waiter only.
  dispatchReply(reply(null), parallel, serial);
  assert.deepEqual(
    got.map(([k]) => k),
    ['p2', 'p1', 'serial'],
  );

  // Garbage: dropped silently.
  dispatchReply('not json', parallel, serial);
  assert.equal(got.length, 3);

  // No serial waiter: untagged reply dropped, nothing throws.
  dispatchReply(reply(null), parallel, null);
  assert.equal(got.length, 3);
});
