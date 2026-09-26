// Run with: node --test web/test
// Verifies the "Run a Portal" pure logic without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PORTAL_CONFIG,
  PORTAL_OS_META,
  PORTAL_OS_ORDER,
  PORTAL_RUN_KEY,
  PORTAL_RELEASE_URL,
  advanceProbe,
  defaultPortalRunStorage,
  detectPortalOs,
  formatProbeLatency,
  inviteLinkFor,
  loadPortalRun,
  quickStartCommand,
  renderConfigSnippet,
  savePortalRun,
} from '../src/application/runPortal.ts';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

test('registry covers linux, docker, and windows', () => {
  assert.deepEqual([...PORTAL_OS_ORDER], ['linux', 'docker', 'windows']);
  for (const os of PORTAL_OS_ORDER) {
    assert.ok(PORTAL_OS_META[os].title.length > 0);
    assert.ok(PORTAL_OS_META[os].blurb.length > 0);
  }
});

test('detects windows and linux from a user agent, unknown otherwise', () => {
  assert.equal(detectPortalOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
  assert.equal(detectPortalOs('Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
  assert.equal(detectPortalOs(''), null);
  assert.equal(detectPortalOs(null), null);
});

test('quick-start snippets are platform-specific and never invent an image', () => {
  const linux = quickStartCommand('linux');
  const docker = quickStartCommand('docker');
  const windows = quickStartCommand('windows');
  assert.ok(linux.includes('run-provider.sh'));
  assert.ok(linux.includes('build.sh services portal-provider'));
  assert.ok(windows.includes('portal-provider.exe'));
  assert.ok(docker.includes('<your-portal-image>'));
  assert.ok(!docker.includes('docker run') || docker.includes('<your-portal-image>'));

  // The nysiris CLI is the one-command path (docs/13) on both native platforms.
  for (const snippet of [linux, windows]) {
    assert.ok(snippet.includes('nysiris-cli'), 'snippet mentions the nysiris CLI');
    assert.ok(snippet.includes('host echo'), 'snippet hosts the echo service');
    assert.ok(snippet.includes('host files'), 'snippet hosts static files');
  }
});

test('config snippet renders the provider env knobs', () => {
  const snippet = renderConfigSnippet({ ...DEFAULT_PORTAL_CONFIG, powBits: 8, ratePerDay: 120 });
  assert.ok(snippet.includes('SP_DATA_DIR=./sp-storage'));
  assert.ok(snippet.includes('PORTAL_POW_BITS=8'));
  assert.ok(snippet.includes('PORTAL_RATE_PER_DAY=120'));
  assert.ok(snippet.includes('PORTAL_DB=./portal.sqlite'));
});

test('config snippet uses PowerShell syntax on windows', () => {
  const snippet = renderConfigSnippet({ ...DEFAULT_PORTAL_CONFIG, powBits: 8 }, 'windows');
  assert.ok(snippet.includes('$env:SP_DATA_DIR = "./sp-storage"'));
  assert.ok(snippet.includes('$env:PORTAL_POW_BITS = "8"'));
  assert.ok(snippet.includes('$env:PORTAL_RATE_PER_DAY = "500"'));
  assert.ok(snippet.includes('$env:PORTAL_DB = "./portal.sqlite"'));
  assert.ok(!snippet.includes('export '), 'no POSIX export lines on windows');
});

test('invite link gets the nym:// scheme when missing', () => {
  assert.equal(inviteLinkFor('id.enc@gw'), 'nym://id.enc@gw');
  assert.equal(inviteLinkFor('nym://id.enc@gw'), 'nym://id.enc@gw');
  assert.equal(inviteLinkFor('  '), '');
});

test('probe state machine: idle → checking → reachable/unreachable', () => {
  assert.equal(advanceProbe('idle', true), 'reachable');
  assert.equal(advanceProbe('checking', false), 'unreachable');
  assert.equal(advanceProbe('idle', false), 'idle');
  assert.equal(advanceProbe('unreachable', true), 'reachable');
});

test('latency line rounds up, never below 1 ms, never jitters on NaN', () => {
  assert.equal(formatProbeLatency(42), 'latency ~42 ms');
  assert.equal(formatProbeLatency(0), 'latency ~1 ms');
  assert.equal(formatProbeLatency(0.4), 'latency ~1 ms');
  assert.equal(formatProbeLatency(NaN), 'latency ~1 ms');
  assert.equal(formatProbeLatency(1234.6), 'latency ~1235 ms');
});

test('release page points at the GitHub latest release', () => {
  assert.equal(PORTAL_RELEASE_URL, 'https://github.com/odelyzid/Nysiris/releases/latest');
});

test('loads defaults without storage and with junk storage', () => {
  assert.deepEqual(loadPortalRun(null), { os: null, config: DEFAULT_PORTAL_CONFIG, providerAddress: '' });
  assert.equal(loadPortalRun(fakeStorage({ [PORTAL_RUN_KEY]: 'not json' })).os, null);
  assert.deepEqual(loadPortalRun(fakeStorage()).config, DEFAULT_PORTAL_CONFIG);
});

test('round-trips portal run preferences', () => {
  const storage = fakeStorage();
  savePortalRun(
    { os: 'docker', config: { ...DEFAULT_PORTAL_CONFIG, powBits: 8 }, providerAddress: 'id.enc@gw' },
    storage,
  );
  const loaded = loadPortalRun(storage);
  assert.equal(loaded.os, 'docker');
  assert.equal(loaded.config.powBits, 8);
  assert.equal(loaded.providerAddress, 'id.enc@gw');
});

test('unknown os and bad numbers fall back to safe defaults', () => {
  const storage = fakeStorage({
    [PORTAL_RUN_KEY]: JSON.stringify({ os: 'beos', config: { powBits: 'x', ratePerDay: 100, dataDir: '/data' } }),
  });
  const loaded = loadPortalRun(storage);
  assert.equal(loaded.os, null);
  assert.equal(loaded.config.powBits, DEFAULT_PORTAL_CONFIG.powBits);
  assert.equal(loaded.config.ratePerDay, 100);
  assert.equal(loaded.config.dataDir, '/data');
});

test('defaultPortalRunStorage is null without a DOM', () => {
  assert.equal(defaultPortalRunStorage(), null);
});
