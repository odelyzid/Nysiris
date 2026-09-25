// Run with: node --test web/test
// Verifies the browser wire-size mirrors in web/src/social/limits.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DM_CIPHERTEXT_BYTES, MAX_POST_BYTES } from '../src/social/limits.ts';

test('browser mirrors stay in step with the provider caps', () => {
  assert.equal(MAX_POST_BYTES, 1400);
  assert.equal(MAX_DM_CIPHERTEXT_BYTES, 1800);
});