// Run with: node --test web/test
// Tunnel status formatting + raw-state normalisation (pure; tunnel.ts only
// imports the SDK dynamically inside functions, so both are node-importable).
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeStatus } from '../src/mixnet/status.ts';
import { normaliseState } from '../src/mixnet/tunnel.ts';

test('describeStatus maps every tunnel state to a label + theme-token tone', () => {
  const ready = describeStatus({ state: 'ready' });
  assert.equal(ready.label, 'Connected — mixnet tunnel ready');
  assert.equal(ready.tone, 'var(--fly-good)');

  const connecting = describeStatus({ state: 'connecting' });
  assert.equal(connecting.tone, 'var(--fly-warn)');

  const shutting = describeStatus({ state: 'shutting_down' });
  assert.equal(shutting.label, 'Shutting down…');

  const down = describeStatus({ state: 'shutdown' });
  assert.equal(down.label, 'Disconnected');
  assert.equal(down.tone, 'var(--fly-muted)');

  const failed = describeStatus({ state: 'failed', reason: 'boom' });
  assert.equal(failed.label, 'Failed: boom');
  assert.equal(failed.tone, 'var(--fly-bad)');

  // Unknown states fail to a neutral label rather than crash.
  assert.deepEqual(describeStatus({ state: 'bogus' }), { label: 'Unknown', tone: 'var(--fly-muted)' });
});

test('normaliseState accepts strings, objects, and rejects garbage', () => {
  assert.deepEqual(normaliseState('connecting'), { state: 'connecting' });
  assert.deepEqual(normaliseState({ state: 'failed', reason: 'x' }), { state: 'failed', reason: 'x' });
  assert.deepEqual(normaliseState(null), { state: 'failed', reason: 'unrecognised tunnel state' });
  assert.deepEqual(normaliseState(42), { state: 'failed', reason: 'unrecognised tunnel state' });
  assert.deepEqual(normaliseState({}), { state: 'failed', reason: 'unrecognised tunnel state' });
});