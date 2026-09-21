// Run with: node --test web/test
// Verifies human-readable error mapping without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError, statusHeadline } from '../src/ui/friendlyErrors.ts';

test('torn-down tunnel explains the reload', () => {
  const out = friendlyError(new Error('mixnet tunnel was torn down; reload the page'));
  assert.equal(out.title, 'Private session ended');
  assert.match(out.help, /Reload the page/);
  assert.ok(out.technical.length > 0);
});

test('timeouts suggest retrying', () => {
  const out = friendlyError(new Error('fetchNym timed out after 90000 ms'));
  assert.equal(out.title, 'Taking longer than usual');
  assert.equal(out.action, 'Try again');
});

test('reply budget maps to a one-time ticket explanation', () => {
  const out = friendlyError(new Error('reply budget exhausted; slow down'));
  assert.equal(out.title, 'Reply could not be sent');
});

test('unknown errors stay calm but keep the technical text', () => {
  const out = friendlyError(new Error('weird wasm explode 0x123'));
  assert.equal(out.title, 'Something went wrong');
  assert.equal(out.technical, 'weird wasm explode 0x123');
});

test('non-Error values never throw', () => {
  assert.equal(friendlyError('plain string').technical, 'plain string');
  assert.equal(friendlyError(null).title, 'Something went wrong');
  assert.equal(friendlyError(undefined).title, 'Something went wrong');
});

test('status headlines use everyday language', () => {
  assert.equal(statusHeadline('ready').title, 'You are protected');
  assert.equal(statusHeadline('connecting').title, 'Connecting…');
  assert.equal(statusHeadline('shutdown').title, 'Not protected');
  assert.equal(statusHeadline('failed').title, 'Something went wrong');
});
