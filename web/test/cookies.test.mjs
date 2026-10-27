// Run with: node --test web/test
// Cookie parsing/matching for clearnet pages fetched through the exit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar, loadCookieJar, saveCookieJar } from '../src/application/cookies.ts';

function memoryStorage() {
  let raw = null;
  return {
    getItem: () => raw,
    setItem: (_key, value) => {
      raw = value;
    },
  };
}

test('stores Set-Cookie and sends it to matching origin and path', () => {
  const jar = new CookieJar([], () => 1000);
  jar.setFromHeader('https://example.com/a/b', 'sid=abc; Path=/a; Secure; HttpOnly');
  assert.equal(jar.headerFor('https://example.com/a/c'), 'sid=abc');
  assert.equal(jar.headerFor('https://example.com/other'), '');
  assert.equal(jar.headerFor('http://example.com/a/c'), '', 'Secure is HTTPS-only');
  assert.equal(jar.headerFor('https://other.example/a'), '');
});

test('domain cookies match subdomains, host-only cookies do not', () => {
  const jar = new CookieJar([], () => 1000);
  jar.setFromHeader('https://www.example.com/', 'site=1; Domain=.example.com; Path=/');
  jar.setFromHeader('https://www.example.com/', 'host=2; Path=/');
  assert.equal(jar.headerFor('https://example.com/'), 'site=1');
  assert.equal(jar.headerFor('https://api.example.com/'), 'site=1');
  assert.equal(jar.headerFor('https://www.example.com/'), 'site=1; host=2');
});

test('max-age/expires delete and expire cookies', () => {
  let now = 1000;
  const jar = new CookieJar([], () => now);
  jar.setFromHeader('https://example.com/', 'a=1; Max-Age=10; Path=/');
  jar.setFromHeader('https://example.com/', 'b=2; Max-Age=0; Path=/');
  assert.equal(jar.headerFor('https://example.com/'), 'a=1');
  now += 11_000;
  assert.equal(jar.headerFor('https://example.com/'), '');
  assert.equal(jar.size, 0);
});

test('a new value replaces the same name/domain/path', () => {
  const jar = new CookieJar([], () => 1000);
  jar.setFromHeader('https://example.com/', 'a=1; Path=/');
  jar.setFromHeader('https://example.com/', 'a=2; Path=/');
  assert.equal(jar.headerFor('https://example.com/'), 'a=2');
  assert.equal(jar.size, 1);
});

test('persists and reloads valid cookies', () => {
  const storage = memoryStorage();
  const jar = new CookieJar([], () => 1000);
  jar.setFromHeader('https://example.com/', 'a=1; Path=/');
  saveCookieJar(storage, jar);
  const loaded = loadCookieJar(storage);
  assert.equal(loaded.headerFor('https://example.com/'), 'a=1');
  assert.equal(loadCookieJar(null).size, 0);
  assert.equal(loadCookieJar(memoryStorage()).size, 0);
});
