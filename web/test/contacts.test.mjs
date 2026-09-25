// Run with: node --test web/test
// Verifies contacts persistence logic without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addContact, defaultContactStorage, loadContacts, saveContacts } from '../src/application/contacts.ts';

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

test('addContact appends, dedupes by name, and always copies', () => {
  const base = [{ name: 'ada', address: 'A.B@C', addedAt: 1 }];
  const added = addContact(base, { name: 'bob', address: 'X.Y@Z', note: 'hi' });
  assert.equal(added.length, 2);
  assert.equal(added[1].name, 'bob');
  assert.equal(added[1].addedAt >= 0, true);
  assert.equal(added[0], base[0]); // existing entry kept by reference
  assert.notEqual(added, base); // but the array itself is fresh

  // Duplicate name (case-insensitive) is a no-op returning a fresh copy.
  const dup = addContact(base, { name: 'ADA', address: 'other@x' });
  assert.equal(dup.length, 1);
  assert.notEqual(dup, base);
  assert.deepEqual(dup, base);

  // Empty names are rejected outright.
  assert.equal(addContact(base, { name: '   ', address: 'a@b' }).length, 1);
});

test('defaultContactStorage is null without a DOM', () => {
  assert.equal(defaultContactStorage(), null);
});
