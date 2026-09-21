// Run with: node --test web/test
// Verifies everyday address labels without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { displayLabel, petnameFor, shortenAddress, threadKeyFor, threadLabel, toPrivateLink } from '../src/ui/share.ts';

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
