// Run with: node --test web/test
// OS launch-link parsing and app URL construction.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deepLinkFromArgs,
  extractDeepLink,
  isNymDeepLink,
  stripDeepLink,
  withOpenLink,
} from '../src/application/deepLinks.ts';

const link = 'nym://abc.def@gateway/portal?x=1';

test('recognises only explicit nym:// links', () => {
  assert.equal(isNymDeepLink(link), true);
  assert.equal(isNymDeepLink('  Nym://ABC.DEF@GW/  '), true);
  assert.equal(isNymDeepLink('https://example.com/'), false);
  assert.equal(isNymDeepLink('abc.def@gateway'), false);
  assert.equal(isNymDeepLink(null), false);
});

test('extracts ?open=, #open= and #nym= values', () => {
  assert.equal(extractDeepLink(`http://127.0.0.1:8080/?open=${encodeURIComponent(link)}`), link);
  assert.equal(extractDeepLink(`http://127.0.0.1:8080/#open=${encodeURIComponent(link)}`), link);
  assert.equal(extractDeepLink(`http://127.0.0.1:8080/#nym=${encodeURIComponent(link)}`), link);
  assert.equal(extractDeepLink('http://127.0.0.1:8080/?open=https%3A%2F%2Fexample.com'), null);
  assert.equal(extractDeepLink('not a url'), null);
});

test('strips only the launch parameter', () => {
  const url = `http://127.0.0.1:8080/path?keep=1&open=${encodeURIComponent(link)}#frag`;
  const stripped = new URL(stripDeepLink(url));
  assert.equal(stripped.searchParams.get('open'), null);
  assert.equal(stripped.searchParams.get('keep'), '1');
  assert.equal(stripped.hash, '#frag');
});

test('builds an app URL that round-trips the link', () => {
  const built = withOpenLink('http://127.0.0.1:8080/', link);
  assert.equal(extractDeepLink(built), link);
  assert.equal(withOpenLink('http://127.0.0.1:8080/', 'https://example.com'), 'http://127.0.0.1:8080/');
});

test('parses native argv forms', () => {
  assert.equal(deepLinkFromArgs(['--root', 'web/dist', link]), link);
  assert.equal(deepLinkFromArgs(['--open', link]), link);
  assert.equal(deepLinkFromArgs([`--open=${link}`]), link);
  assert.equal(deepLinkFromArgs(['--no-open']), null);
  assert.equal(deepLinkFromArgs(['--open', 'https://example.com']), null);
});
