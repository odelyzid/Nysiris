// Run with: node --test web/test
// Verifies community-tab persistence without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOCIAL_TAB_META,
  SOCIAL_TAB_ORDER,
  defaultSocialTabStorage,
  loadSocialTab,
  saveSocialTab,
} from '../src/application/tabs.ts';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

test('registry covers timeline, messages, and about', () => {
  assert.deepEqual([...SOCIAL_TAB_ORDER].sort(), ['about', 'messages', 'timeline']);
  for (const id of SOCIAL_TAB_ORDER) {
    assert.ok(SOCIAL_TAB_META[id].title.length > 0);
    assert.ok(SOCIAL_TAB_META[id].blurb.length > 0);
  }
});

test('defaults to the timeline without storage', () => {
  assert.equal(loadSocialTab(fakeStorage()), 'timeline');
  assert.equal(loadSocialTab(null), 'timeline');
  assert.equal(loadSocialTab(undefined), 'timeline');
});

test('round-trips the active tab', () => {
  const storage = fakeStorage();
  saveSocialTab('messages', storage);
  assert.equal(loadSocialTab(storage), 'messages');
  saveSocialTab('about', storage);
  assert.equal(loadSocialTab(storage), 'about');
});

test('unknown values fall back to the timeline', () => {
  assert.equal(loadSocialTab(fakeStorage({ 'fly.social.tab': 'nope' })), 'timeline');
});

test('defaultSocialTabStorage is null without a DOM', () => {
  assert.equal(defaultSocialTabStorage(), null);
});
