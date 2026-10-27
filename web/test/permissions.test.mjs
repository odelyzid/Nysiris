// Run with: node --test web/test
// Per-site permission decisions: defaults, persistence, caps, reset.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SCOPES,
  PERMISSION_NAMES,
  PermissionRegistry,
  loadPermissions,
  permissionScopeFor,
  savePermissions,
} from '../src/application/permissions.ts';

function memoryStorage() {
  let raw = null;
  return {
    getItem: () => raw,
    setItem: (_key, value) => {
      raw = value;
    },
  };
}

test('defaults to ask and stores explicit allow/deny per scope', () => {
  const registry = new PermissionRegistry();
  assert.equal(registry.get('https://example.com', 'camera'), 'ask');
  registry.set('https://example.com', 'camera', 'allow');
  registry.set('https://example.com', 'microphone', 'deny');
  assert.equal(registry.get('https://example.com', 'camera'), 'allow');
  assert.equal(registry.allows('https://example.com', 'camera'), true);
  assert.equal(registry.denied('https://example.com', 'microphone'), true);
  assert.equal(registry.get('https://other.example', 'camera'), 'ask');
});

test('setting ask removes the override; reset clears one site', () => {
  const registry = new PermissionRegistry();
  registry.set('https://example.com', 'camera', 'allow');
  registry.set('https://example.com', 'camera', 'ask');
  assert.equal(registry.size, 0);
  registry.set('https://example.com', 'camera', 'deny');
  registry.set('https://other.example', 'camera', 'allow');
  registry.clear('https://example.com');
  assert.equal(registry.size, 1);
  assert.equal(registry.get('https://other.example', 'camera'), 'allow');
  registry.clear();
  assert.equal(registry.size, 0);
});

test('round-trips through storage and drops malformed values', () => {
  const storage = memoryStorage();
  const registry = new PermissionRegistry();
  for (const name of PERMISSION_NAMES) registry.set('nym://abc.def@gateway', name, 'allow');
  savePermissions(storage, registry);
  const loaded = loadPermissions(storage);
  for (const name of PERMISSION_NAMES) assert.equal(loaded.get('nym://abc.def@gateway', name), 'allow');
  assert.equal(loadPermissions(null).size, 0);

  const bad = memoryStorage();
  bad.setItem('fly.browser.permissions.v1', JSON.stringify({ version: 2, scopes: { x: { camera: 'allow' } } }));
  assert.equal(loadPermissions(bad).size, 0);
});

test('scopes are origins for clearnet and addresses for Nym', () => {
  assert.equal(permissionScopeFor('https://example.com/a'), 'https://example.com');
  assert.equal(permissionScopeFor('nym://abc.def@gateway/path'), 'nym://abc.def@gateway');
  assert.equal(permissionScopeFor(''), 'app');
});

test('caps the number of remembered scopes', () => {
  const registry = new PermissionRegistry();
  for (let i = 0; i < MAX_SCOPES + 5; i += 1) registry.set(`https://s${i}.example`, 'camera', 'allow');
  assert.equal(registry.size, MAX_SCOPES);
  assert.equal(registry.get('https://s0.example', 'camera'), 'ask', 'oldest scope evicted');
});
