// Run with: node --test web/test
// Object/embed classification and safe filename rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEmbedded,
  embeddedFilename,
  isEmbeddedFetchable,
} from '../src/application/embeddedDocuments.ts';

test('classifies by declared MIME type before extension', () => {
  assert.deepEqual(classifyEmbedded('application/pdf', 'https://x/doc'), {
    kind: 'pdf',
    contentType: 'application/pdf',
  });
  assert.equal(classifyEmbedded('image/png', 'https://x/noext').kind, 'image');
  assert.equal(classifyEmbedded('text/plain; charset=utf-8', 'https://x/a.bin').kind, 'text');
  assert.equal(classifyEmbedded('audio/mpeg', 'https://x/a').kind, 'media');
  assert.equal(classifyEmbedded('application/zip', 'https://x/a.zip').kind, 'download');
});

test('falls back to the URL extension', () => {
  assert.equal(classifyEmbedded('', 'https://x/report.pdf').kind, 'pdf');
  assert.equal(classifyEmbedded('', 'https://x/photo.JPG').kind, 'image');
  assert.equal(classifyEmbedded('', 'https://x/readme.md').kind, 'text');
  assert.equal(classifyEmbedded('', 'https://x/movie.webm').kind, 'media');
  assert.equal(classifyEmbedded('', 'https://x/file.unknownext').kind, 'download');
});

test('HTML/plugin objects are blocked with an explanation', () => {
  for (const type of ['text/html', 'application/xhtml+xml', 'application/x-shockwave-flash']) {
    const result = classifyEmbedded(type, 'https://x/page');
    assert.equal(result.kind, 'blocked');
    assert.match(result.reason ?? '', /disabled/i);
  }
});

test('only transport-safe URLs are fetchable', () => {
  assert.equal(isEmbeddedFetchable('https://example.com/a.pdf'), true);
  assert.equal(isEmbeddedFetchable('http://example.com/a.pdf'), true);
  assert.equal(isEmbeddedFetchable('nym://abc.def@gw/a.pdf'), true);
  assert.equal(isEmbeddedFetchable('javascript:alert(1)'), false);
  assert.equal(isEmbeddedFetchable('data:application/pdf;base64,AA=='), false);
  assert.equal(isEmbeddedFetchable(null), false);
});

test('filename prefers the title, then the URL basename, then the type', () => {
  assert.equal(embeddedFilename('https://x/a.pdf', 'Annual report', 'application/pdf'), 'Annual report');
  assert.equal(embeddedFilename('https://x/docs/a.pdf', '', 'application/pdf'), 'a.pdf');
  assert.equal(embeddedFilename('https://x/', '', 'application/pdf'), 'embedded.pdf');
  assert.equal(embeddedFilename('https://x/', '', 'application/octet-stream'), 'embedded.bin');
});
