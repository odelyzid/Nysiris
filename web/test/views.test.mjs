// Run with: node --test web/test
// Verifies primary-navigation persistence without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEW_META,
  VIEW_ORDER,
  defaultViewStorage,
  loadActiveView,
  loadAdvancedVisible,
  loadOnboarded,
  saveActiveView,
  saveAdvancedVisible,
  saveOnboarded,
} from '../src/ui/views.ts';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

test('registry covers the five everyday views', () => {
  assert.deepEqual([...VIEW_ORDER].sort(), ['home', 'messages', 'portal', 'service', 'settings']);
  for (const id of VIEW_ORDER) {
    assert.ok(VIEW_META[id].title.length > 0);
    assert.ok(VIEW_META[id].blurb.length > 0);
  }
});

test('defaults: home view, advanced hidden, onboarding not done', () => {
  assert.equal(loadActiveView(fakeStorage()), 'home');
  assert.equal(loadActiveView(null), 'home');
  assert.equal(loadAdvancedVisible(fakeStorage()), false);
  assert.equal(loadOnboarded(fakeStorage()), false);
});

test('round-trips the active view', () => {
  const storage = fakeStorage();
  saveActiveView('portal', storage);
  assert.equal(loadActiveView(storage), 'portal');
});

test('unknown or malformed view falls back to home', () => {
  assert.equal(loadActiveView(fakeStorage({ 'fly.view.active': 'nope' })), 'home');
  assert.equal(loadActiveView(fakeStorage({ 'fly.view.active': 'not json' })), 'home');
});

test('advanced visibility is opt-in and persists', () => {
  const storage = fakeStorage();
  saveAdvancedVisible(true, storage);
  assert.equal(loadAdvancedVisible(storage), true);
  saveAdvancedVisible(false, storage);
  assert.equal(loadAdvancedVisible(storage), false);
});

test('onboarding flag persists', () => {
  const storage = fakeStorage();
  saveOnboarded(true, storage);
  assert.equal(loadOnboarded(storage), true);
});

test('defaultViewStorage is null without a DOM', () => {
  assert.equal(defaultViewStorage(), null);
});
