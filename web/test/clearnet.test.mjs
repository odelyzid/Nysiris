// Run with: node --test web/test
// Clearnet redirect/cookie/auth pipeline with a fake transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clearnetFetch } from '../src/application/clearnet.ts';
import { CookieJar } from '../src/application/cookies.ts';
import { CredentialStore } from '../src/application/auth.ts';

function response(body, status = 200, headers = {}) {
  return new Response(status === 204 || status === 304 ? null : body, { status, headers });
}

test('follows redirects, captures intermediate cookies, and reports the final URL', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      const headers = new Headers();
      headers.set('location', '/next');
      headers.append('set-cookie', 'sid=1; Path=/');
      return response('', 302, headers);
    }
    return response('final', 200, { 'content-type': 'text/plain', 'set-cookie': 'done=1; Path=/' });
  };
  const jar = new CookieJar([], () => 1000);

  const result = await clearnetFetch('https://example.com/start#frag', undefined, { fetch, jar });

  assert.deepEqual(
    calls.map((call) => call.url),
    ['https://example.com/start', 'https://example.com/next'],
  );
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[1].init.headers.cookie, 'sid=1', 'redirect-hop cookie is sent');
  assert.equal(result.url, 'https://example.com/next');
  assert.equal(result.redirects, 1);
  assert.equal(result.setCookies.length, 2);
  assert.equal(jar.headerFor('https://example.com/next'), 'sid=1; done=1');
  assert.equal(await result.response.text(), 'final');
});

test('reports a 401 challenge and retries with Basic credentials when stored', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (!init.headers.authorization) {
      return response('no', 401, { 'www-authenticate': 'Basic realm="Members"' });
    }
    return response('yes', 200, { 'content-type': 'text/plain' });
  };
  const credentials = new CredentialStore(() => 1);

  const first = await clearnetFetch('https://example.com/private', undefined, { fetch, credentials });
  assert.equal(first.response.status, 401);
  assert.deepEqual(first.authChallenge, { scheme: 'basic', label: 'Basic', realm: 'Members' });
  assert.equal(first.authenticated, false);

  credentials.set('https://example.com', 'Members', 'alice', 'pw');
  const second = await clearnetFetch('https://example.com/private', undefined, { fetch, credentials });
  assert.equal(second.response.status, 200);
  assert.equal(second.authenticated, true);
  assert.equal(Buffer.from(calls[1].init.headers.authorization.slice(6), 'base64').toString(), 'alice:pw');
  assert.equal(await second.response.text(), 'yes');
});

test('a rejected password returns the challenge with authenticated=true', async () => {
  const fetch = async () => response('still no', 401, { 'www-authenticate': 'Basic realm="x"' });
  const credentials = new CredentialStore(() => 1);
  credentials.set('https://example.com', 'x', 'bad', 'wrong');
  const result = await clearnetFetch('https://example.com/', undefined, { fetch, credentials });
  assert.equal(result.response.status, 401);
  assert.equal(result.authenticated, true);
  assert.equal(result.authChallenge.realm, 'x');
});

test('enforces the redirect limit and rejects non-http targets', async () => {
  let count = 0;
  const loop = async () => {
    count += 1;
    return response('', 302, { location: '/again' });
  };
  await assert.rejects(
    clearnetFetch('https://example.com/', undefined, { fetch: loop, maxRedirects: 2 }),
    /too many redirects/,
  );
  assert.equal(count, 3);

  const ftp = async () => response('', 301, { location: 'ftp://example.com/file' });
  await assert.rejects(clearnetFetch('https://example.com/', undefined, { fetch: ftp }), /unsupported URL/);
});

test('303 rewrites POST to GET without the body', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return response('', 303, { location: '/done' });
    return response('ok');
  };
  const result = await clearnetFetch(
    'https://example.com/submit',
    { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } },
    { fetch },
  );
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].init.body, undefined);
  assert.equal(result.url, 'https://example.com/done');
});

test('cookies are applied even when the response is 401 or 304', async () => {
  const jar = new CookieJar([], () => 1000);
  const fetch401 = async () =>
    response('', 401, { 'www-authenticate': 'Basic realm="r"', 'set-cookie': 'a=1; Path=/' });
  const one = await clearnetFetch('https://example.com/', undefined, { fetch: fetch401, jar });
  assert.equal(one.response.status, 401);
  assert.equal(jar.headerFor('https://example.com/'), 'a=1');

  const fetch304 = async () => response('', 304, { etag: '"x"', 'set-cookie': 'b=2; Path=/' });
  const two = await clearnetFetch('https://example.com/', undefined, { fetch: fetch304, jar });
  assert.equal(two.response.status, 304);
  assert.equal(jar.headerFor('https://example.com/'), 'a=1; b=2');
});
