// Run with: node --test web/test
// Document/tab model: history, stale-response guards, closing, persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HISTORY,
  MAX_TABS,
  addBlankTab,
  applyPage,
  canGoBack,
  canGoForward,
  closeBrowserTab,
  failPage,
  historyEntry,
  loadBrowserTabs,
  navigateTab,
  newBrowserTab,
  pageKindFor,
  restoreBrowserTabs,
  saveBrowserTabs,
  serializeBrowserTabs,
  stopPage,
  tabTitle,
} from '../src/application/browser.ts';
import { resolveNavigationInput } from '../src/application/navigation.ts';

const NYM =
  '6BH3ALNQ9L39qsei6QjofNcRRdFydoq82UJ2KE3XTZnq.6vdcFysfmE4yXqsgn3hd2uPPpoE5kvkvot4tYqWWhvKJ@CcYinhLeFU8n6xs78FG6Rz3wvosGTCU2hLB1CZyfkMVe';

function tab() {
  return newBrowserTab('t1');
}

function go(state, raw, token, push = true) {
  return navigateTab(state, resolveNavigationInput(raw), { token, push });
}

test('new tab is blank and labelled', () => {
  const state = tab();
  assert.equal(state.kind, null);
  assert.equal(state.url, '');
  assert.equal(tabTitle(state), 'New tab');
  assert.equal(canGoBack(state), false);
  assert.equal(canGoForward(state), false);
});

test('navigation pushes history and creates a canonical URL', () => {
  let state = go(tab(), `nym://${NYM}/a`, 1);
  assert.equal(state.loading, true);
  assert.equal(state.kind, 'nym');
  // Social binds only after a successful response.
  assert.equal(state.service, '');
  state = applyPage(state, 1, { status: 200, contentType: 'text/html', body: '<title>A</title>' });
  assert.equal(state.service, NYM);
  assert.deepEqual(state.history, [`nym://${NYM}/a`]);
  assert.equal(state.historyIndex, 0);

  state = go(state, `nym://${NYM}/b`, 2);
  assert.deepEqual(state.history, [`nym://${NYM}/a`, `nym://${NYM}/b`]);
  assert.equal(state.historyIndex, 1);
  assert.equal(canGoBack(state), true);
  assert.equal(historyEntry(state, -1)?.url, `nym://${NYM}/a`);
  assert.equal(historyEntry(state, -1)?.index, 0);
  assert.equal(historyEntry(state, 1), null);
});

test('back/forward reuses history without duplicating entries', () => {
  let state = go(tab(), 'https://example.com/one', 1);
  state = go(state, 'https://example.com/two', 2);
  const back = historyEntry(state, -1);
  assert.ok(back);

  state = navigateTab(state, resolveNavigationInput(back.url), {
    token: 3,
    push: false,
    historyIndex: back.index,
  });
  assert.deepEqual(state.history, ['https://example.com/one', 'https://example.com/two']);
  assert.equal(state.historyIndex, 0);
  assert.equal(canGoForward(state), true);

  const forward = historyEntry(state, 1);
  assert.ok(forward);
  state = navigateTab(state, resolveNavigationInput(forward.url), {
    token: 4,
    push: false,
    historyIndex: forward.index,
  });
  assert.equal(state.historyIndex, 1);
});

test('navigating after going back truncates the forward branch', () => {
  let state = go(tab(), 'https://a.example/', 1);
  state = go(state, 'https://b.example/', 2);
  const back = historyEntry(state, -1);
  state = navigateTab(state, resolveNavigationInput(back.url), {
    token: 3,
    push: false,
    historyIndex: back.index,
  });
  state = go(state, 'https://c.example/', 4);
  assert.deepEqual(state.history, ['https://a.example/', 'https://c.example/']);
  assert.equal(state.historyIndex, 1);
  assert.equal(historyEntry(state, 1), null);
});

test('history is capped and the index follows the trimmed window', () => {
  let state = tab();
  for (let i = 0; i < MAX_HISTORY + 7; i += 1) {
    state = go(state, `https://example.com/${i}`, i + 1);
  }
  assert.equal(state.history.length, MAX_HISTORY);
  assert.equal(state.historyIndex, MAX_HISTORY - 1);
  assert.equal(state.history[state.historyIndex], `https://example.com/${MAX_HISTORY + 6}`);
});

test('applyPage extracts title/kind only for the current token', () => {
  let state = go(tab(), 'https://example.com/', 1);
  const stale = applyPage(state, 99, { status: 200, contentType: 'text/html', body: '<title>Old</title>' });
  assert.equal(stale.content, null);
  assert.equal(stale.loading, true);

  state = applyPage(state, 1, {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><title> Hello  &amp; world </title>',
  });
  assert.equal(state.loading, false);
  assert.equal(state.status, 200);
  assert.equal(state.content.kind, 'html');
  assert.equal(state.title, 'Hello & world');
  assert.equal(tabTitle(state), 'Hello & world');
});

test('failPage and stopPage invalidate in-flight work', () => {
  let state = go(tab(), 'https://example.com/', 1);
  const failed = failPage(state, 1, 'connection refused');
  assert.equal(failed.loading, false);
  assert.equal(failed.error, 'connection refused');

  state = go(state, 'https://example.com/two', 2);
  state = stopPage(state);
  assert.equal(state.loading, false);
  assert.equal(state.navToken, 3);
  assert.equal(applyPage(state, 2, { status: 200, contentType: 'text/plain', body: 'late' }).content, null);
});

test('page kind follows content type with an HTML fallback', () => {
  assert.equal(pageKindFor('application/json'), 'json');
  assert.equal(pageKindFor('text/plain'), 'text');
  assert.equal(pageKindFor('application/xml'), 'text');
  assert.equal(pageKindFor('image/png'), 'image');
  assert.equal(pageKindFor('application/pdf'), 'binary');
  assert.equal(pageKindFor(''), 'text');
  assert.equal(pageKindFor('', '<!doctype html><html></html>'), 'html');
});

test('closing tabs chooses a neighbour and always keeps one', () => {
  const a = newBrowserTab('a');
  const b = newBrowserTab('b');
  const c = newBrowserTab('c');
  const first = closeBrowserTab([a, b, c], 'b', 'b');
  assert.deepEqual(
    first.tabs.map((t) => t.id),
    ['a', 'c'],
  );
  assert.equal(first.activeId, 'c');

  const second = closeBrowserTab([a], 'a', 'a', () => 'blank');
  assert.deepEqual(
    second.tabs.map((t) => t.id),
    ['blank'],
  );
  assert.equal(second.activeId, 'blank');
});

test('blank tabs are capped', () => {
  const tabs = Array.from({ length: MAX_TABS }, (_, i) => newBrowserTab(`t${i}`));
  const result = addBlankTab(tabs, () => 'overflow');
  assert.equal(result.tabs.length, MAX_TABS);
  assert.equal(result.tab.id, `t${MAX_TABS - 1}`);
});

test('serialization persists URLs/history but not page bodies', () => {
  let state = go(tab(), `nym://${NYM}/a`, 1);
  state = applyPage(state, 1, { status: 200, contentType: 'text/html', body: '<title>A</title>' });
  const raw = serializeBrowserTabs([state], 't1');
  const restored = restoreBrowserTabs(raw, () => 'unused');
  assert.equal(restored.activeId, 't1');
  assert.equal(restored.tabs[0].url, `nym://${NYM}/a`);
  assert.equal(restored.tabs[0].title, 'A');
  assert.deepEqual(restored.tabs[0].history, [`nym://${NYM}/a`]);
  assert.equal(restored.tabs[0].content, null);
  assert.equal(restored.tabs[0].loading, false);
});

test('bad persisted state falls back to one blank tab', () => {
  for (const raw of [null, '', 'not json', '{"version":2}', '{"version":1,"tabs":[]}']) {
    const restored = restoreBrowserTabs(raw, () => 'blank');
    assert.equal(restored.tabs.length, 1);
    assert.equal(restored.tabs[0].id, 'blank');
  }
});

test('storage wrapper survives a throwing or absent store', () => {
  const saved = [];
  const storage = {
    setItem: (key, value) => saved.push([key, value]),
    getItem: () => saved[0]?.[1] ?? null,
  };
  saveBrowserTabs(storage, [tab()], 't1');
  assert.equal(saved[0][0], 'fly.browser.tabs.v1');
  assert.equal(loadBrowserTabs(storage, () => 'blank').activeId, 't1');
  assert.equal(loadBrowserTabs(null, () => 'blank').tabs[0].id, 'blank');
  assert.equal(
    loadBrowserTabs(
      {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => undefined,
      },
      () => 'blank',
    ).tabs[0].id,
    'blank',
  );
});
