// Run with: node --test web/test
// Service-worker helpers degrade cleanly outside a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_SHELL_CACHE,
  RUNTIME_CACHE,
  clearAppShellCaches,
  isOnline,
  registerServiceWorker,
  serviceWorkerSupported,
  unregisterServiceWorkers,
  watchConnectivity,
} from '../src/pwa.ts';

test('reports unsupported and online without a browser runtime', async () => {
  assert.equal(serviceWorkerSupported(), false);
  assert.equal(isOnline(), true);
  const status = await registerServiceWorker();
  assert.deepEqual(status, { supported: false, registered: false, controlled: false, error: null });
  assert.equal(await unregisterServiceWorkers(), 0);
  await clearAppShellCaches();
});

test('watchConnectivity is a no-op without a window and returns cleanup', () => {
  const seen = [];
  const stop = watchConnectivity((online) => seen.push(online));
  assert.equal(typeof stop, 'function');
  stop();
});

test('cache names are versioned and distinct', () => {
  assert.notEqual(APP_SHELL_CACHE, RUNTIME_CACHE);
  assert.match(APP_SHELL_CACHE, /^nysiris-shell-/);
  assert.match(RUNTIME_CACHE, /^nysiris-runtime-/);
});
