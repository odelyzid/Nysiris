// Run with: node --test web/test
// HTTP header semantics: validators, Content-Disposition, redirects.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conditionalRequestHeaders,
  etagMatches,
  filenameFromDisposition,
  headerValue,
  headersToRecord,
  isRedirectStatus,
  parseContentDisposition,
  parseContentLength,
  readSetCookies,
  redirectRequest,
  responseValidators,
} from '../src/application/httpHeaders.ts';

test('header lookup is case-insensitive for records and Headers', () => {
  assert.equal(headerValue({ 'Content-Type': 'text/html' }, 'content-type'), 'text/html');
  assert.equal(headerValue({ 'content-type': 'text/plain' }, 'Content-Type'), 'text/plain');
  assert.equal(headerValue(new Headers({ ETag: '"x"' }), 'etag'), '"x"');
  assert.equal(headerValue(null, 'etag'), '');
});

test('headersToRecord lowercases names and combines duplicate values', () => {
  const headers = new Headers();
  headers.append('X-Test', 'one');
  headers.append('X-Test', 'two');
  assert.deepEqual(headersToRecord(headers), { 'x-test': 'one, two' });
});

test('Set-Cookie repeats survive through getSetCookie', () => {
  const headers = new Headers();
  headers.append('set-cookie', 'a=1; Path=/');
  headers.append('set-cookie', 'b=2; Path=/; Secure');
  assert.deepEqual(readSetCookies(headers), ['a=1; Path=/', 'b=2; Path=/; Secure']);
  assert.deepEqual(readSetCookies(new Headers()), []);
});

test('parses plain and RFC 5987 Content-Disposition filenames', () => {
  assert.deepEqual(parseContentDisposition('attachment; filename="report.pdf"'), {
    type: 'attachment',
    filename: 'report.pdf',
  });
  assert.equal(filenameFromDisposition('attachment; filename=plain.txt'), 'plain.txt');
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"), 'résumé.pdf');
  assert.equal(filenameFromDisposition('inline'), null);
  assert.equal(filenameFromDisposition(null), null);
});

test('filenames are reduced to a safe basename', () => {
  assert.equal(filenameFromDisposition('attachment; filename="../../etc/passwd"'), 'passwd');
  assert.equal(filenameFromDisposition('attachment; filename="..\\\\secret.txt"'), 'secret.txt');
  assert.equal(filenameFromDisposition('attachment; filename=".."'), null);
  assert.equal(filenameFromDisposition('attachment; filename="bad\u0000name.bin"'), 'badname.bin');
  assert.equal(filenameFromDisposition('attachment; filename="my file (1).zip"'), 'my file (1).zip');
});

test('response validators drive conditional request headers', () => {
  const validators = responseValidators({ ETag: '"abc"', 'Last-Modified': 'Wed, 21 Oct 2015 07:28:00 GMT' });
  assert.deepEqual(validators, { etag: '"abc"', lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' });
  assert.deepEqual(conditionalRequestHeaders(validators), {
    'if-none-match': '"abc"',
    'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT',
  });
  assert.deepEqual(conditionalRequestHeaders({ lastModified: validators.lastModified }), {
    'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT',
  });
  assert.deepEqual(conditionalRequestHeaders(null), {});
});

test('etagMatches implements weak comparison, lists, and star', () => {
  assert.equal(etagMatches('"abc"', '"abc"'), true);
  assert.equal(etagMatches('W/"abc"', '"abc"'), true);
  assert.equal(etagMatches('"abc", "def"', '"def"'), true);
  assert.equal(etagMatches('*', '"anything"'), true);
  assert.equal(etagMatches('"abc"', '"def"'), false);
  assert.equal(etagMatches('', '"abc"'), false);
  assert.equal(etagMatches('"abc"', null), false);
});

test('redirect classification and method rewriting follow Fetch rules', () => {
  assert.equal(isRedirectStatus(302), true);
  assert.equal(isRedirectStatus(304), false);
  assert.deepEqual(redirectRequest(303, 'POST', 'body'), { method: 'GET', body: undefined });
  assert.deepEqual(redirectRequest(302, 'POST', 'body'), { method: 'GET', body: undefined });
  assert.deepEqual(redirectRequest(307, 'POST', 'body'), { method: 'POST', body: 'body' });
  assert.deepEqual(redirectRequest(301, 'GET', undefined), { method: 'GET', body: undefined });
});

test('content length accepts only non-negative integers', () => {
  assert.equal(parseContentLength('0'), 0);
  assert.equal(parseContentLength('1400'), 1400);
  assert.equal(parseContentLength('-1'), null);
  assert.equal(parseContentLength('1.5'), null);
  assert.equal(parseContentLength(undefined), null);
});
