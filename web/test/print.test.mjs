// Run with: node --test web/test
// Print document construction and escaping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrintDocument, escapeHtml } from '../src/shared/print.ts';

test('escapes text and titles', () => {
  assert.equal(escapeHtml('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;');
  const doc = buildPrintDocument({ title: '<Report>', text: '<b>not html</b>' });
  assert.match(doc, /<title>&lt;Report&gt;<\/title>/);
  assert.match(doc, /<pre>&lt;b&gt;not html&lt;\/b&gt;<\/pre>/);
});

test('passes sanitised HTML through and wraps image data URLs', () => {
  const html = buildPrintDocument({ title: 'Page', html: '<h1>ok</h1>' });
  assert.match(html, /<body><h1>ok<\/h1><\/body>/);

  const image = buildPrintDocument({ title: 'Pic', imageUrl: 'data:image/png;base64,AAAA' });
  assert.match(image, /<img src="data:image\/png;base64,AAAA" alt="Pic">/);
  const unsafe = buildPrintDocument({ title: 'Pic', imageUrl: 'javascript:alert(1)' });
  assert.doesNotMatch(unsafe, /<img/);
});
