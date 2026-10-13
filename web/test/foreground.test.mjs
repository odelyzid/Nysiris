// Run with: node --test web/test
// Verifies the foreground-service contract (web/src/adapters/driven/foreground.mjs):
// detection and graceful degradation without a Capacitor runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isForegroundAvailable, startForeground, stopForeground } from '../src/adapters/driven/foreground.mjs';

function setCapacitor(plugin) {
  if (plugin === undefined) {
    // @ts-expect-error deliberate: simulate a desktop browser
    delete globalThis.Capacitor;
  } else {
    // @ts-expect-error deliberate: test double for the native plugin
    globalThis.Capacitor = { Plugins: { NysirisForeground: plugin } };
  }
}

test('degrades gracefully without a Capacitor runtime', async () => {
  setCapacitor(undefined);
  assert.equal(isForegroundAvailable(), false);
  assert.deepEqual(await startForeground(), { available: false, running: false });
  assert.equal(await stopForeground(), undefined);
});

test('rejects partial plugin objects', async () => {
  setCapacitor({ start: async () => ({ running: true }) });
  assert.equal(isForegroundAvailable(), false);
  setCapacitor(undefined);
});

test('starts and stops through the plugin', async () => {
  const calls = [];
  setCapacitor({
    start: async () => {
      calls.push('start');
      return { running: true };
    },
    stop: async () => {
      calls.push('stop');
      return { running: false };
    },
  });
  try {
    assert.equal(isForegroundAvailable(), true);
    assert.deepEqual(await startForeground(), { available: true, running: true });
    await stopForeground();
    assert.deepEqual(calls, ['start', 'stop']);
  } finally {
    setCapacitor(undefined);
  }
});

test('a failing native start is reported, never thrown', async () => {
  setCapacitor({
    start: async () => {
      throw new Error('service denied');
    },
    stop: async () => {},
  });
  try {
    assert.deepEqual(await startForeground(), { available: true, running: false });
  } finally {
    setCapacitor(undefined);
  }
});
