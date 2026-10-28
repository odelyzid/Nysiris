// Run with: node --test web/test
// Portal view model: verified content ordering, wiki dedupe, trust filtering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPortalView } from '../src/application/portalView.ts';
import { PortalTrustStore } from '../src/application/portalTrust.ts';
import { PORTAL_KINDS, encodePortalContent } from '../src/domain/portalContent.ts';

const authorA = 'a'.repeat(64);
const authorB = 'b'.repeat(64);
const obj = (id, kind, content) => ({
  id: id.repeat(64).slice(0, 64),
  kind,
  author: authorA,
  payload: encodePortalContent(content),
  sig: '0'.repeat(128),
});
const entry = (author, seq, object) => ({ author, seq, objId: object.id, sig: '0'.repeat(128) });

function replica() {
  const postsA = obj('1', PORTAL_KINDS.post, { version: 1, body: 'first', replyTo: null, attachments: [] });
  const postsA2 = obj('2', PORTAL_KINDS.post, { version: 1, body: 'second', replyTo: null, attachments: [] });
  const profileA = obj('3', PORTAL_KINDS.profile, { version: 1, name: 'Alice', bio: '', avatarId: null });
  const wikiA = obj('4', PORTAL_KINDS.wikiPage, { version: 1, slug: 'start', title: 'Old', markdown: 'old' });
  const wikiB = obj('5', PORTAL_KINDS.wikiPage, { version: 1, slug: 'start', title: 'New', markdown: 'new' });
  return {
    entriesByAuthor: {
      [authorA]: [entry(authorA, 0, postsA), entry(authorA, 1, postsA2), entry(authorA, 2, profileA), entry(authorA, 3, wikiA)],
      [authorB]: [entry(authorB, 4, wikiB)],
    },
    objectsById: {
      [postsA.id]: { ...postsA, author: authorA },
      [postsA2.id]: { ...postsA2, author: authorA },
      [profileA.id]: { ...profileA, author: authorA },
      [wikiA.id]: { ...wikiA, author: authorA },
      [wikiB.id]: { ...wikiB, author: authorB },
    },
  };
}

test('builds feed/profile/wiki from verified objects', () => {
  const view = buildPortalView(replica());
  assert.equal(view.posts.length, 2);
  assert.equal(view.posts[0].body, 'second');
  assert.equal(view.profile?.name, 'Alice');
  assert.equal(view.wiki.length, 1);
  assert.equal(view.wiki[0].title, 'New');
  assert.equal(view.authors.length, 2);
  assert.equal(view.unknown, 0);
});

test('blocked authors disappear from posts and wiki', () => {
  const trust = new PortalTrustStore();
  trust.set('nym://one@gw', authorB, 'blocked');
  const view = buildPortalView(replica(), { trust, scope: 'nym://one@gw' });
  assert.equal(view.wiki[0].title, 'Old');
  assert.equal(view.authors.length, 1);
  assert.equal(view.authors[0].author, authorA);
});

test('trusted-only keeps configured authors; malformed/unknown payloads are counted', () => {
  const base = replica();
  const bad = { ...obj('6', PORTAL_KINDS.post, { version: 1, body: 'x', replyTo: null, attachments: [] }), payload: new Uint8Array([0]) };
  base.entriesByAuthor[authorA] = [...base.entriesByAuthor[authorA], entry(authorA, 4, bad)];
  base.objectsById[bad.id] = bad;
  const trust = new PortalTrustStore();
  trust.set('nym://one@gw', authorA, 'trusted');
  const view = buildPortalView(base, { trust, scope: 'nym://one@gw', trustedOnly: true });
  assert.equal(view.authors.length, 1);
  assert.equal(view.unknown, 1);
});
