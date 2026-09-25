// Run with: node --test web/test
// Verifies hidden-service poll pacing without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_POLL_MS, MAX_POLL_MS, isDefinitiveServiceError, pollDelayMs } from '../src/mixnet/backoff.mjs';

test('pollDelayMs grows exponentially then caps', () => {
  assert.equal(pollDelayMs(0), BASE_POLL_MS);
  assert.equal(pollDelayMs(1), BASE_POLL_MS);
  assert.equal(pollDelayMs(2), BASE_POLL_MS * 2);
  assert.equal(pollDelayMs(3), BASE_POLL_MS * 4);
  assert.equal(pollDelayMs(4), BASE_POLL_MS * 8);
  assert.equal(pollDelayMs(100), MAX_POLL_MS);
});

test('pollDelayMs is total: negative, fractional and non-finite inputs are safe', () => {
  assert.equal(pollDelayMs(-5), BASE_POLL_MS);
  assert.equal(pollDelayMs(1.9), BASE_POLL_MS);
  assert.equal(pollDelayMs(Number.NaN), BASE_POLL_MS);
  assert.equal(pollDelayMs(Number.POSITIVE_INFINITY), BASE_POLL_MS);
});

test('pollDelayMs honours custom bounds', () => {
  assert.equal(pollDelayMs(5, { baseMs: 100, maxMs: 1_000 }), 1_000);
  assert.equal(pollDelayMs(3, { baseMs: 100, maxMs: 1_000 }), 400);
});

test('isDefinitiveServiceError flags client errors except 429', () => {
  assert.equal(isDefinitiveServiceError(400), true);
  assert.equal(isDefinitiveServiceError(404), true);
  assert.equal(isDefinitiveServiceError(499), true);
  assert.equal(isDefinitiveServiceError(429), false, 'rate limiting is transient');
  assert.equal(isDefinitiveServiceError(500), false);
  assert.equal(isDefinitiveServiceError(200), false);
  assert.equal(isDefinitiveServiceError(0), false);
  assert.equal(isDefinitiveServiceError(undefined), false);
});
