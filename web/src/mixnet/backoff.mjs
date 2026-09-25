/**
 * Poll pacing for hidden-service reads.
 *
 * A service that goes away must not be hammered forever: each consecutive
 * transport failure doubles the gap before the next automatic poll, up to a
 * cap. A *definitive* answer from the service (a well-formed envelope carrying
 * a client error such as `404 unknown route`) is different — the service is
 * reachable but this request is not acceptable, so repeating it on any cadence
 * cannot change the outcome. Callers stop the automatic poller for those and
 * wait for an explicit Retry.
 *
 * Pure and dependency-free (no browser globals), so `node --test web/test`
 * covers it offline.
 */

/** Gap between polls when healthy (30 s). */
export const BASE_POLL_MS = 30_000;

/** Longest automatic retry gap after repeated failures (10 min). */
export const MAX_POLL_MS = 10 * 60_000;

/**
 * Milliseconds before the next automatic poll.
 *
 * `failures` is the number of consecutive failed polls (0 = healthy):
 * 0 → base, 1 → base, 2 → 2×base, 3 → 4×base, … capped at `maxMs`.
 *
 * @param {number} failures consecutive failure count
 * @param {{ baseMs?: number, maxMs?: number }} [options]
 * @returns {number} delay in milliseconds
 */
export function pollDelayMs(failures, options = {}) {
  const baseMs = options.baseMs ?? BASE_POLL_MS;
  const maxMs = options.maxMs ?? MAX_POLL_MS;
  const n = Number.isFinite(failures) ? Math.max(0, Math.floor(failures)) : 0;
  if (n <= 1) return baseMs;
  return Math.min(baseMs * 2 ** (n - 1), maxMs);
}

/**
 * Whether a service response is a definitive client error: the service
 * answered, but the request is not acceptable (`400`..`499`). Retrying cannot
 * help until the service changes, so the automatic poller should stop.
 *
 * `429` (rate limited) and `5xx` (server-side, possibly transient) are excluded
 * — those fall back to exponential backoff instead.
 *
 * @param {number} status HTTP-style status from the response envelope
 * @returns {boolean}
 */
export function isDefinitiveServiceError(status) {
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 429;
}
