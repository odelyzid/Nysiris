// Run with: node --test web/test
// Portal background sync timing, backoff, and pause conditions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PORTAL_SYNC_BASE_MS,
  PORTAL_SYNC_MAX_MS,
  isPortalSyncDue,
  portalSyncBlocked,
  portalSyncDelay,
} from '../src/application/portalScheduler.ts';

test('backoff grows exponentially and caps at one hour', () => {
  assert.equal(portalSyncDelay(0), PORTAL_SYNC_BASE_MS);
  assert.ok(portalSyncDelay(1) >= PORTAL_SYNC_BASE_MS * 2);
  assert.ok(portalSyncDelay(2) >= PORTAL_SYNC_BASE_MS * 4);
  assert.ok(portalSyncDelay(10) <= PORTAL_SYNC_MAX_MS * 1.1);
});

test('due only after a previous sync and the backoff delay', () => {
  assert.equal(isPortalSyncDue(null, 1_000_000), false);
  assert.equal(isPortalSyncDue(1_000, 2_000), false);
  assert.equal(isPortalSyncDue(1_000, 1_000 + PORTAL_SYNC_BASE_MS), true);
});

test('offline, hidden, and in-flight syncs are blocked', () => {
  assert.equal(portalSyncBlocked(true, false, false), false);
  assert.equal(portalSyncBlocked(false, false, false), true);
  assert.equal(portalSyncBlocked(true, true, false), true);
  assert.equal(portalSyncBlocked(true, false, true), true);
});
