/**
 * Portal background replication scheduler.
 *
 * Replication is page-driven: the mixnet client is a WASM instance in the app,
 * not a service-worker sync. While the app is open we poll each followed
 * workspace on a jittered interval, back off on failures, and pause when the
 * browser is offline or the document is hidden. A foreground service keeps the
 * page alive on Android; a fully closed app cannot sync.
 */

export const PORTAL_SYNC_BASE_MS = 5 * 60_000;
export const PORTAL_SYNC_MAX_MS = 60 * 60_000;

/** Exponential backoff with a small deterministic jitter, capped at one hour. */
export function portalSyncDelay(failures: number, baseMs = PORTAL_SYNC_BASE_MS): number {
  const exponent = Math.max(0, Math.min(4, Math.floor(failures)));
  const delay = Math.min(PORTAL_SYNC_MAX_MS, baseMs * 2 ** exponent);
  // ±10% jitter derived from a stable integer, no randomness needed.
  const jitter = Math.floor((delay * (failures % 3)) / 30);
  return Math.max(1_000, delay + jitter);
}

/** True when a workspace is due for a background attempt. */
export function isPortalSyncDue(
  lastSyncedAt: number | null,
  now: number,
  failures = 0,
  baseMs = PORTAL_SYNC_BASE_MS,
): boolean {
  if (lastSyncedAt === null) return false;
  return now - lastSyncedAt >= portalSyncDelay(failures, baseMs);
}

/** Pause conditions shared by the timer and manual triggers. */
export function portalSyncBlocked(online: boolean, hidden: boolean, syncing: boolean): boolean {
  return !online || hidden || syncing;
}
