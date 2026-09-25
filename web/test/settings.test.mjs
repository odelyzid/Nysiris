// Run with: node --test web/test
// Verifies the timeline-scope toggle persistence in web/src/social/settings.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultBooleanStorage,
  loadTrustedOnly,
  saveTrustedOnly,
} from '../src/social/settings.ts';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

test('loads the toggle with the frozen "1"/"0" encoding', () => {
  assert.equal(loadTrustedOnly(fakeStorage()), false);
  assert.equal(loadTrustedOnly(fakeStorage({ 'fly.social.trustedOnly': '1' })), true);
  assert.equal(loadTrustedOnly(fakeStorage({ 'fly.social.trustedOnly': '0' })), false);
  assert.equal(loadTrustedOnly(fakeStorage({ 'fly.social.trustedOnly': 'true' })), false);
});

test('save writes the same key and encoding back', () => {
  const storage = fakeStorage();
  saveTrustedOnly(true, storage);
  assert.equal(storage.getItem('fly.social.trustedOnly'), '1');
  saveTrustedOnly(false, storage);
  assert.equal(storage.getItem('fly.social.trustedOnly'), '0');
});

test('failing storage degrades to the default without throwing', () => {
  const broken = {
    getItem: () => {
      throw new Error('quota');
    },
    setItem: () => {
      throw new Error('quota');
    },
  };
  assert.equal(loadTrustedOnly(broken), false);
  assert.doesNotThrow(() => saveTrustedOnly(true, broken));
});

test('defaultBooleanStorage returns localStorage in node-like globals or null', () => {
  const storage = defaultBooleanStorage();
  assert.ok(storage === null || typeof storage.getItem === 'function');
});