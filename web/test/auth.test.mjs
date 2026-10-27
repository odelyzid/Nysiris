// Run with: node --test web/test
// HTTP auth challenges and the session-only credential store.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CredentialStore,
  authScopeFor,
  basicAuthorization,
  isSupportedChallenge,
  parseAuthChallenge,
} from '../src/application/auth.ts';

test('parses Basic/Digest challenges and quoted realms', () => {
  assert.deepEqual(parseAuthChallenge('Basic realm="Restricted area"'), {
    scheme: 'basic',
    label: 'Basic',
    realm: 'Restricted area',
  });
  assert.equal(parseAuthChallenge('digest realm="x", nonce="abc"').scheme, 'digest');
  assert.equal(parseAuthChallenge('Bearer').realm, '');
  assert.equal(parseAuthChallenge('Basic realm=simple').realm, 'simple');
  assert.equal(parseAuthChallenge(''), null);
  assert.equal(parseAuthChallenge(null), null);
  assert.equal(parseAuthChallenge('!!!'), null);
});

test('only Basic is supported by the generated credentials', () => {
  assert.equal(isSupportedChallenge(parseAuthChallenge('Basic realm="x"')), true);
  assert.equal(isSupportedChallenge(parseAuthChallenge('Digest realm="x"')), false);
  assert.equal(isSupportedChallenge(null), false);
});

test('basicAuthorization encodes user:password as base64', () => {
  const header = basicAuthorization('alice', 's3cret');
  assert.match(header, /^Basic /);
  assert.equal(Buffer.from(header.slice(6), 'base64').toString('utf8'), 'alice:s3cret');
});

test('scopes are origins for clearnet and addresses for Nym', () => {
  assert.equal(authScopeFor('https://example.com/a?b#c'), 'https://example.com');
  assert.equal(authScopeFor('http://example.com:8080/x'), 'http://example.com:8080');
  assert.equal(authScopeFor('nym://abc.def@gateway/path'), 'nym://abc.def@gateway');
  assert.equal(authScopeFor('abc.def@gateway/path'), 'abc.def@gateway');
  assert.equal(authScopeFor(''), '');
});

test('credentials are looked up by exact realm, then most recent scope', () => {
  let now = 100;
  const store = new CredentialStore(() => now);
  store.set('https://example.com', 'admin', 'alice', 'one');
  now += 10;
  store.set('https://example.com', 'files', 'bob', 'two');

  assert.equal(
    Buffer.from(store.authorizationFor('https://example.com', 'admin').slice(6), 'base64').toString(),
    'alice:one',
  );
  // Unknown realm falls back to the newest credential for the origin.
  assert.equal(Buffer.from(store.authorizationFor('https://example.com').slice(6), 'base64').toString(), 'bob:two');
  assert.equal(store.has('https://example.com', 'admin'), true);
  assert.equal(store.has('https://other.example'), false);
  assert.equal(store.authorizationFor('https://other.example'), '');
});

test('blank credentials are ignored and clear removes a scope', () => {
  const store = new CredentialStore(() => 1);
  store.set('https://example.com', '', '', '');
  assert.equal(store.size, 0);
  store.set('https://example.com', '', 'alice', 'x');
  store.set('https://other.example', '', 'bob', 'y');
  assert.equal(store.size, 2);
  store.clear('https://example.com');
  assert.equal(store.size, 1);
  assert.equal(store.has('https://example.com'), false);
  store.clear();
  assert.equal(store.size, 0);
});
