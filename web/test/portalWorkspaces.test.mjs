// Run with: node --test web/test
// Portal workspaces: persistence, active selection, upsert/remove, caps.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PORTAL_WORKSPACES,
  emptyWorkspace,
  findWorkspace,
  loadPortalWorkspaces,
  normalisePortalScope,
  portalTransportAddress,
  removeWorkspace,
  savePortalWorkspaces,
  upsertWorkspace,
} from '../src/application/portalWorkspaces.ts';

const scope = (n) => `nym://id${n}.enc@gw`;

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, value),
  };
}

test('upsert moves a workspace to the front and dedupes by scope', () => {
  let list = [];
  list = upsertWorkspace(list, emptyWorkspace(scope(1), 'One'));
  list = upsertWorkspace(list, emptyWorkspace(scope(2), 'Two'));
  list = upsertWorkspace(list, { ...emptyWorkspace(scope(1), 'One updated') });
  assert.equal(list.length, 2);
  assert.equal(list[0].scope, scope(1));
  assert.equal(list[0].title, 'One updated');
  assert.equal(findWorkspace(list, scope(2))?.title, 'Two');
  assert.equal(removeWorkspace(list, scope(1)).length, 1);
});

test('caps the workspace list', () => {
  let list = [];
  for (let i = 0; i < MAX_PORTAL_WORKSPACES + 5; i += 1) list = upsertWorkspace(list, emptyWorkspace(scope(i)));
  assert.equal(list.length, MAX_PORTAL_WORKSPACES);
});

test('round-trips state and repairs the active id', () => {
  const storage = memoryStorage();
  const state = {
    version: 1,
    activeId: scope(2),
    workspaces: [emptyWorkspace(scope(1)), emptyWorkspace(scope(2))],
  };
  savePortalWorkspaces(storage, state);
  const loaded = loadPortalWorkspaces(storage);
  assert.equal(loaded.activeId, scope(2));
  assert.equal(loaded.workspaces.length, 2);

  savePortalWorkspaces(storage, { ...state, activeId: 'missing' });
  assert.equal(loadPortalWorkspaces(storage).activeId, scope(1));
});

test('normalises bare addresses and derives the transport recipient', () => {
  assert.equal(normalisePortalScope('abc.def@gw'), 'nym://abc.def@gw');
  assert.equal(portalTransportAddress('nym://abc.def@gw/wiki'), 'abc.def@gw');
  assert.equal(portalTransportAddress('https://portal.example/x'), 'https://portal.example/x');
  assert.equal(findWorkspace([emptyWorkspace('nym://abc.def@gw')], 'abc.def@gw')?.scope, 'nym://abc.def@gw');
});

test('drops malformed scopes and sections', () => {
  const storage = memoryStorage();
  storage.setItem(
    'fly.portal.workspaces.v1',
    JSON.stringify({
      version: 1,
      activeId: '',
      workspaces: [
        { scope: 'https://only-web.example', title: 'web', activeSection: 'wiki' },
        { scope: 'not-a-scope' },
        { scope: scope(3), title: '', activeSection: 'nope' },
      ],
    }),
  );
  const loaded = loadPortalWorkspaces(storage);
  assert.equal(loaded.workspaces.length, 2);
  assert.equal(loaded.workspaces.find((workspace) => workspace.scope === scope(3))?.activeSection, 'feed');
  assert.equal(loadPortalWorkspaces(null).workspaces.length, 0);
});
