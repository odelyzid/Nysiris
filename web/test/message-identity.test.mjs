// Run with: node --test web/test
// Verifies the messaging client id stays STABLE across sessions
// (web/src/mixnet/messageIdentity.ts): a fresh id per load rotates the Nym
// address and drops replies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { messageClientId, newClientId } from '../src/mixnet/messageIdentity.ts';

const KEY = 'fly.messages.clientId';

function memoryStorage(initial) {
  const map = new Map(initial ? Object.entries(initial) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
    _map: map,
  };
}

test('creates and persists an id on first use', () => {
  const storage = memoryStorage();
  const first = messageClientId(storage);
  assert.match(first, /^nysiris-/);
  assert.equal(storage.getItem(KEY), first, 'id is stored');
});

test('returns the same id on later calls (stable identity)', () => {
  const storage = memoryStorage();
  const first = messageClientId(storage);
  assert.equal(messageClientId(storage), first);
  assert.equal(messageClientId(storage), first);
});

test('reuses an existing stored id', () => {
  const storage = memoryStorage({ [KEY]: 'nysiris-existing' });
  assert.equal(messageClientId(storage), 'nysiris-existing');
});

test('treats a blank stored id as absent', () => {
  const storage = memoryStorage({ [KEY]: '   ' });
  assert.notEqual(messageClientId(storage), '   ');
  assert.match(messageClientId(storage), /^nysiris-/);
});

test('still returns an id when storage is unavailable or throws', () => {
  assert.match(messageClientId(null), /^nysiris-/);
  const throwing = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.match(messageClientId(throwing), /^nysiris-/);
});

test('newClientId is unique', () => {
  assert.notEqual(newClientId(), newClientId());
});
