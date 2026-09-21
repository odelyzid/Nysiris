// Run with: node --test web/test
// Verifies the leak-guard rules without a browser or bundler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideLeak, hostnameOf, isRouted } from '../src/mixnet/routedHosts.mjs';

const ROUTED = new Set(['example.com', 'api.example.com']);
const BASE = 'https://app.local/';

test('hostnameOf parses absolute and relative URLs, case-insensitively', () => {
  assert.equal(hostnameOf('https://Example.COM/x', BASE), 'example.com');
  assert.equal(hostnameOf('/local/path', BASE), 'app.local');
  assert.equal(hostnameOf('not a url', 'not a base either'), null);
});

test('isRouted matches allow-listed hosts only', () => {
  assert.equal(isRouted('https://example.com/a', BASE, ROUTED), true);
  assert.equal(isRouted('https://sub.example.com/a', BASE, ROUTED), false, 'subdomains are not routed');
  assert.equal(isRouted('https://api.example.com/v1', BASE, ROUTED), true);
  assert.equal(isRouted('https://other.test/', BASE, ROUTED), false);
});

test('a direct request to a routed host is a leak', () => {
  const decision = decideLeak('https://example.com/', BASE, ROUTED, false);
  assert.deepEqual(decision, { leak: true, block: false });
});

test('fail-closed blocks routed hosts, fail-open only logs', () => {
  assert.deepEqual(decideLeak('https://example.com/', BASE, ROUTED, true), {
    leak: true,
    block: true,
  });
  assert.deepEqual(decideLeak('https://example.com/', BASE, ROUTED, false), {
    leak: true,
    block: false,
  });
});

test('non-routed hosts are never blocked', () => {
  assert.deepEqual(decideLeak('https://cdn.other/', BASE, ROUTED, true), {
    leak: false,
    block: false,
  });
});

test('relative URLs resolve against the page and can be routed', () => {
  const routed = new Set(['app.local']);
  assert.deepEqual(decideLeak('/api/secret', BASE, routed, true), {
    leak: true,
    block: true,
  });
});

test('unparseable URLs are treated as not-routed, never a crash', () => {
  assert.deepEqual(decideLeak('::bad::', BASE, ROUTED, true), { leak: false, block: false });
});
