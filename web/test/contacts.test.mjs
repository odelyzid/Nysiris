// Run with: node --test web/test
// Verifies contacts persistence logic without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadContacts, saveContacts } from '../src/ui/contacts.ts';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

test('empty or missing storage means no contacts', () => {
  assert.deepEqual(loadContacts(fakeStorage()), []);
  assert.deepEqual(loadContacts(null), []);
});

test('round-trips contacts', () => {
  const storage = fakeStorage();
  const contacts = [{ name: 'shop', address: 'A.B@C', inviter: 'D', note: 'hi', addedAt: 1 }];
  saveContacts(contacts, storage);
  assert.deepEqual(loadContacts(storage), contacts);
});

test('drops malformed entries', () => {
  const storage = fakeStorage({
    'fly.contacts': JSON.stringify([{ name: 'ok', address: 'A' }, { name: 42 }, 'x']),
  });
  assert.deepEqual(loadContacts(storage), [{ name: 'ok', address: 'A' }]);
  assert.deepEqual(loadContacts(fakeStorage({ 'fly.contacts': 'nope' })), []);
});
