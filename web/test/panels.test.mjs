// Run with: node --test web/test
// Verifies panel open-state persistence without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_META, PANEL_ORDER, defaultStorage, loadOpenPanels, saveOpenPanels } from '../src/ui/panels.ts';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

test('registry covers every panel id', () => {
  assert.deepEqual([...PANEL_ORDER].sort(), ['connection', 'contacts', 'fetch', 'log', 'messages', 'portal']);
  for (const id of PANEL_ORDER) {
    assert.ok(PANEL_META[id].title.length > 0);
  }
});

test('empty or missing storage means all panels closed', () => {
  assert.deepEqual(loadOpenPanels(fakeStorage()), []);
  assert.deepEqual(loadOpenPanels(null), []);
  assert.deepEqual(loadOpenPanels(undefined), []);
});

test('round-trips the open set', () => {
  const storage = fakeStorage();
  saveOpenPanels(['messages', 'log'], storage);
  assert.deepEqual(loadOpenPanels(storage), ['messages', 'log']);
});

test('drops unknown or malformed entries', () => {
  assert.deepEqual(loadOpenPanels(fakeStorage({ 'fly.panels.open': '["messages","nope",42]' })), ['messages']);
  assert.deepEqual(loadOpenPanels(fakeStorage({ 'fly.panels.open': 'not json' })), []);
  assert.deepEqual(loadOpenPanels(fakeStorage({ 'fly.panels.open': '{"a":1}' })), []);
});

test('defaultStorage is null without a DOM', () => {
  assert.equal(defaultStorage(), null);
});
