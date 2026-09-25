// Run with: node --test web/test
// Conversation list over decrypted DM records: dedupe, grouping, unread,
// read watermarks, and cache persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DM_RECORDS,
  addDmRecord,
  defaultDmStore,
  groupConversations,
  loadDmCache,
  loadDmRead,
  markConversationRead,
  saveDmCache,
  saveDmRead,
} from '../src/application/conversations.ts';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

const rec = (over = {}) => ({
  peer: 'aa'.repeat(32),
  incoming: true,
  text: 'hi',
  at: 1000,
  ts: 1000,
  msgId: 'bb'.repeat(16),
  ...over,
});

test('addDmRecord dedupes by msgId and caps length', () => {
  const a = rec({ msgId: 'id-1' });
  const again = rec({ msgId: 'id-1', text: 'different' });
  let records = addDmRecord([], a);
  assert.equal(records.length, 1);
  // Same id: ignored, original kept, same reference (no copy).
  assert.equal(addDmRecord(records, again), records);

  records = [];
  for (let i = 0; i < MAX_DM_RECORDS + 10; i += 1) {
    records = addDmRecord(records, rec({ msgId: `id-${i}`, at: i }));
  }
  assert.equal(records.length, MAX_DM_RECORDS);
  assert.equal(records[0].msgId, 'id-10');
  assert.equal(records[records.length - 1].msgId, `id-${MAX_DM_RECORDS + 9}`);
});

test('groupConversations groups per peer, newest first, unread from watermark', () => {
  const records = [
    rec({ peer: 'alice', at: 100, msgId: 'm1' }),
    rec({ peer: 'bob', at: 300, msgId: 'm2' }),
    rec({ peer: 'alice', at: 200, msgId: 'm3', incoming: false }),
    rec({ peer: 'alice', at: 400, msgId: 'm4' }),
  ];
  const convos = groupConversations(records, { alice: 150 });
  assert.equal(convos.length, 2);
  // Newest conversation first.
  assert.equal(convos[0].peer, 'alice');
  assert.equal(convos[1].peer, 'bob');
  // Messages oldest first within a conversation.
  assert.deepEqual(
    convos[0].messages.map((m) => m.msgId),
    ['m1', 'm3', 'm4'],
  );
  // Only incoming past the watermark counts (m4; m1 is read, m3 is ours).
  assert.equal(convos[0].unread, 1);
  assert.equal(convos[1].unread, 1);
  assert.equal(convos[0].lastAt, 400);
});

test('markConversationRead only moves the watermark forward', () => {
  const read = markConversationRead({}, 'alice', 500);
  assert.deepEqual(read, { alice: 500 });
  // Backward move: same reference, unchanged.
  assert.equal(markConversationRead(read, 'alice', 100), read);
  const fwd = markConversationRead(read, 'alice', 600);
  assert.deepEqual(fwd, { alice: 600 });
  assert.deepEqual(read, { alice: 500 });
});

test('cache and watermarks round-trip and drop garbage', () => {
  const store = fakeStorage();
  saveDmCache([rec(), { junk: true }, rec({ msgId: 'm2' })], store);
  const loaded = loadDmCache(store);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[1].msgId, 'm2');

  saveDmRead({ alice: 123 }, store);
  assert.deepEqual(loadDmRead(store), { alice: 123 });
  assert.deepEqual(loadDmRead(fakeStorage({ 'fly.social.dmread': 'nope' })), {});
  assert.deepEqual(loadDmRead(fakeStorage({ 'fly.social.dmread': '{"a":"b"}' })), {});
  assert.deepEqual(loadDmCache(fakeStorage()), []);
});

test('defaultDmStore is null without a DOM', () => {
  assert.equal(defaultDmStore(), null);
});
