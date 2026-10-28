// Run with: node --test web/test
// Escaped markdown subset: blocks, inline spans, and link safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInlineSpans, parseMarkdownBlocks, safeHref } from '../src/application/portalMarkdown.ts';

test('parses headings, paragraphs, lists, quotes, and fences', () => {
  const blocks = parseMarkdownBlocks(
    ['# Title', '', 'Hello **world**.', '', '- one', '- two', '', '1. first', '2. second', '', '> quoted', '', '```ts', 'const x = 1;', '```'].join('\n'),
  );
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['heading', 'paragraph', 'list', 'list', 'quote', 'code'],
  );
  assert.deepEqual(blocks[2], { type: 'list', ordered: false, items: ['one', 'two'] });
  assert.deepEqual(blocks[3], { type: 'list', ordered: true, items: ['first', 'second'] });
  assert.equal(blocks[5].language, 'ts');
});

test('parses inline emphasis, code, and links', () => {
  assert.deepEqual(parseInlineSpans('a **b** *c* `d` [e](https://x/e)'), [
    { type: 'text', text: 'a ' },
    { type: 'bold', text: 'b' },
    { type: 'text', text: ' ' },
    { type: 'italic', text: 'c' },
    { type: 'text', text: ' ' },
    { type: 'code', text: 'd' },
    { type: 'text', text: ' ' },
    { type: 'link', text: 'e', href: 'https://x/e' },
  ]);
});

test('rejects scriptable links but keeps the text inert', () => {
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,x'), null);
  assert.equal(safeHref('nym://abc.def@gw/x'), 'nym://abc.def@gw/x');
  const spans = parseInlineSpans('[x](javascript:alert(1))');
  assert.equal(spans.map((span) => span.text).join(''), '[x](javascript:alert(1))');
  assert.ok(spans.every((span) => span.type === 'text'));
});

test('does not loop on unmatched markers', () => {
  assert.deepEqual(parseInlineSpans('*open'), [{ type: 'text', text: '*open' }]);
  assert.deepEqual(parseInlineSpans('`open'), [{ type: 'text', text: '`open' }]);
  assert.deepEqual(parseInlineSpans(''), []);
});
