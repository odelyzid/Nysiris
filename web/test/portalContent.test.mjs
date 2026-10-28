// Run with: node --test web/test
// Portal payload schema: encode/parse caps and fail-closed shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PORTAL_KINDS,
  encodePortalContent,
  parsePortalContent,
  portalContentLabel,
} from '../src/domain/portalContent.ts';

const id = 'a'.repeat(64);

test('round-trips a post and wiki page', () => {
  const post = { version: 1, body: 'hello', replyTo: id, attachments: [id] };
  const bytes = encodePortalContent(post);
  assert.deepEqual(parsePortalContent(PORTAL_KINDS.post, bytes), post);

  const page = { version: 1, slug: 'start-here', title: 'Start', markdown: '# Hi' };
  assert.deepEqual(parsePortalContent(PORTAL_KINDS.wikiPage, encodePortalContent(page)), page);
});

test('rejects wrong versions, unknown kinds, and malformed payloads', () => {
  assert.equal(parsePortalContent(PORTAL_KINDS.post, new TextEncoder().encode('{"version":2,"body":"x"}')), null);
  assert.equal(parsePortalContent('unknown/kind', new TextEncoder().encode('{}')), null);
  assert.equal(parsePortalContent(PORTAL_KINDS.post, new TextEncoder().encode('not json')), null);
  assert.equal(
    parsePortalContent(PORTAL_KINDS.post, new TextEncoder().encode(JSON.stringify({ version: 1, body: '' }))),
    null,
  );
});

test('rejects bad ids, slugs, and oversized payloads', () => {
  const badId = JSON.stringify({ version: 1, body: 'x', replyTo: 'abc' });
  assert.equal(parsePortalContent(PORTAL_KINDS.post, new TextEncoder().encode(badId)), null);

  const badSlug = JSON.stringify({ version: 1, slug: '../x', title: 'x', markdown: 'x' });
  assert.equal(parsePortalContent(PORTAL_KINDS.wikiPage, new TextEncoder().encode(badSlug)), null);

  assert.throws(() =>
    encodePortalContent({ version: 1, body: 'x'.repeat(20 * 1024), replyTo: null, attachments: [] }),
  );
});

test('labels known kinds', () => {
  assert.equal(portalContentLabel(PORTAL_KINDS.wikiPage), 'Wiki page');
  assert.equal(portalContentLabel('custom/thing'), 'custom/thing');
});
