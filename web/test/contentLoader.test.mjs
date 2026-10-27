// Run with: node --test web/test
// Content loader: URL resolution, budgets, and CSS inlining (no DOM needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createResourceLoader,
  resolveLinkUrl,
  resolveResourceUrl,
  rewriteCss,
} from '../src/application/contentLoader.ts';

const NYM_BASE = 'nym://abc.def@gw/dir/page';
const WEB_BASE = 'https://example.com/dir/page';

test('resolves relative resources against both address spaces', () => {
  assert.equal(resolveResourceUrl('style.css', WEB_BASE), 'https://example.com/dir/style.css');
  assert.equal(resolveResourceUrl('/img/logo.png', WEB_BASE), 'https://example.com/img/logo.png');
  assert.equal(resolveResourceUrl('style.css', NYM_BASE), 'nym://abc.def@gw/dir/style.css');
  assert.equal(resolveResourceUrl('../up.png', NYM_BASE), 'nym://abc.def@gw/up.png');
});

test('rejects unsafe or non-fetchable schemes', () => {
  for (const raw of ['javascript:alert(1)', 'mailto:a@b', 'tel:123', 'blob:https://x/1', 'about:blank']) {
    assert.equal(resolveResourceUrl(raw, WEB_BASE), null, raw);
    assert.equal(resolveLinkUrl(raw, WEB_BASE), null, raw);
  }
  assert.equal(resolveResourceUrl('#frag', WEB_BASE), null);
  assert.equal(resolveLinkUrl('#frag', WEB_BASE), null);
  // Protocol-relative links on a Nym base are not a valid Nym address.
  assert.equal(resolveResourceUrl('//cdn.example/x.png', NYM_BASE), null);
});

test('passes data URLs through and resolves links', () => {
  assert.equal(resolveResourceUrl('data:image/png;base64,AA==', WEB_BASE), 'data:image/png;base64,AA==');
  assert.equal(resolveLinkUrl('/next', WEB_BASE), 'https://example.com/next');
  assert.equal(resolveLinkUrl('/next', NYM_BASE), 'nym://abc.def@gw/next');
});

test('rewrites CSS urls and imports to self-contained data', async () => {
  const seen = [];
  const loader = {
    async load(url, kind) {
      seen.push([url, kind]);
      if (kind === 'stylesheet') {
        return {
          status: 200,
          contentType: 'text/css',
          bytes: new TextEncoder().encode('.imported{background:url(../img/up.png)}'),
        };
      }
      return { status: 200, contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
    },
  };
  const css = [
    '@import "theme.css";',
    '@import url(https://example.com/extra.css) screen;',
    '.a{background:url(img/a.png)}',
    '.b{background:url("data:image/gif;base64,AA==")}',
  ].join('\n');
  const output = await rewriteCss(css, WEB_BASE, loader);
  assert.match(output, /@media screen/);
  assert.match(output, /data:image\/png;base64,/);
  assert.doesNotMatch(output, /@import/);
  assert.doesNotMatch(output, /https?:\/\//);
  assert.match(output, /data:image\/gif;base64,AA==/);
  // Stylesheet URLs are resolved relative to the importing stylesheet.
  assert.ok(seen.some(([url, kind]) => kind === 'stylesheet' && url === 'https://example.com/dir/theme.css'));
});

test('failed CSS assets become a transparent pixel, never a live URL', async () => {
  const loader = { load: async () => null };
  const output = await rewriteCss('.a{background:url(/missing.png)}', WEB_BASE, loader);
  assert.match(output, /url\("data:image\/gif;base64,/);
  assert.doesNotMatch(output, /missing\.png/);
});

test('resource budgets cap count, size, and total bytes', async () => {
  const payload = new Uint8Array(10);
  const countLoader = createResourceLoader(async () => ({ status: 200, contentType: 'image/png', bytes: payload }), {
    maxResources: 1,
    maxResourceBytes: 100,
    maxTotalBytes: 100,
  });
  assert.ok(await countLoader.load('https://a/1.png', 'image'));
  assert.equal(await countLoader.load('https://a/2.png', 'image'), null);
  assert.equal(countLoader.stats.resources, 1);
  assert.equal(countLoader.stats.truncated, true);
  // Deduplication does not consume another slot.
  assert.ok(await countLoader.load('https://a/1.png', 'image'));

  const sizeLoader = createResourceLoader(
    async () => ({ status: 200, contentType: 'image/png', bytes: new Uint8Array(101) }),
    { maxResources: 4, maxResourceBytes: 100, maxTotalBytes: 1000 },
  );
  assert.equal(await sizeLoader.load('https://a/big.png', 'image'), null);
  assert.equal(sizeLoader.stats.truncated, true);
  assert.equal(sizeLoader.stats.failed, 1);
});
