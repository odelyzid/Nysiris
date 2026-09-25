// Run with: node --test web/test
// Verifies everyday address labels without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInboxThreads,
  contactAddressOf,
  displayLabel,
  formatFetchedBody,
  isContactThread,
  petnameFor,
  shortenAddress,
  threadKeyFor,
  threadLabel,
  threadUnread,
  toPrivateLink,
} from '../src/shared/share.ts';

test('shortens long addresses, passes short ones through', () => {
  assert.equal(shortenAddress('ABCDEFGHIJ0123456789'), 'ABCDEF…6789');
  assert.equal(shortenAddress('short'), 'short');
  assert.equal(shortenAddress(''), '');
});

test('private links always carry the scheme', () => {
  assert.equal(toPrivateLink('id.enc@gw'), 'nym://id.enc@gw');
  assert.equal(toPrivateLink('nym://id.enc@gw'), 'nym://id.enc@gw');
  assert.equal(toPrivateLink(''), '');
});

test('petname wins over the short address', () => {
  assert.equal(displayLabel('id.enc@gw', 'maya'), 'maya');
  assert.equal(displayLabel('ABCDEFGHIJ0123456789', null), 'ABCDEF…6789');
});

test('petname lookup matches bare and schemed variants', () => {
  const contacts = [{ name: 'maya', address: 'id.enc@gw' }];
  assert.equal(petnameFor('id.enc@gw', contacts), 'maya');
  assert.equal(petnameFor('nym://id.enc@gw', contacts), 'maya');
  assert.equal(petnameFor('other.addr@gw', contacts), null);
});

test('thread keys prefer sender tags', () => {
  assert.equal(threadKeyFor({ senderTag: 'abc' }, 0), 'tag:abc');
  assert.equal(threadKeyFor({}, 3), 'direct:3');
});

test('thread labels name contacts, tags, and fallbacks', () => {
  const contacts = [{ name: 'ada', address: 'id1.enc1@gw1' }];
  assert.equal(threadLabel('contact:id1.enc1@gw1', contacts), 'ada');
  assert.equal(threadLabel('contact:unknown@gw', contacts), 'unknown@gw');
  assert.equal(threadLabel('tag:abcdef123456', []), 'Chat abcdef…3456');
  assert.equal(threadLabel('direct:2', []), 'Chat');
});

test('contact thread keys are recognized and addressable', () => {
  assert.equal(isContactThread('contact:id.enc@gw'), true);
  assert.equal(isContactThread('tag:abc'), false);
  assert.equal(contactAddressOf('contact:id.enc@gw'), 'id.enc@gw');
  assert.equal(contactAddressOf('tag:abc'), '');
});

test('buildInboxThreads dedupes sender tags then appends contact keys', () => {
  const inbox = [{ senderTag: 'aaa' }, {}, { senderTag: 'aaa' }, { senderTag: 'bbb' }];
  const contacts = [{ address: 'id1.enc1@gw1' }, { address: 'id2.enc2@gw2' }];
  assert.deepEqual(buildInboxThreads(inbox, contacts), [
    'tag:aaa',
    'direct:1',
    'tag:bbb',
    'contact:id1.enc1@gw1',
    'contact:id2.enc2@gw2',
  ]);
  // Never mutates its inputs.
  assert.equal(inbox.length, 4);
  assert.equal(contacts.length, 2);
});

test('threadUnread never goes negative', () => {
  assert.equal(threadUnread(5, 2), 3);
  assert.equal(threadUnread(5, 5), 0);
  assert.equal(threadUnread(5, 99), 0);
  assert.equal(threadUnread(0, 0), 0);
});

test('formatFetchedBody pretty-prints JSON and truncates the rest', () => {
  assert.equal(formatFetchedBody('{"a":1}', 'application/json'), '{\n  "a": 1\n}');
  assert.equal(formatFetchedBody('hello', 'text/plain'), 'hello');
  // Invalid JSON falls back to raw text.
  assert.equal(formatFetchedBody('{oops', 'application/json'), '{oops');
  // Truncation applies to non-JSON bodies and after pretty-printing.
  assert.equal(formatFetchedBody('x'.repeat(50), 'text/plain', 10), 'x'.repeat(10));
});
