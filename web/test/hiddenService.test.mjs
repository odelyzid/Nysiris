// Run with: node --test web/test
// Verifies the hidden-service envelope helpers without a browser or bundler.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base58Decode,
  checkPath,
  decodeInviteCompact,
  decodeResponse,
  encodeInviteCompact,
  encodeRequest,
  parseInviteLink,
  parseNymAddress,
  resolvePetname,
  splitNymUri,
} from '../src/mixnet/hiddenService.mjs';

test('encodeRequest builds the bridge envelope', () => {
  const json = encodeRequest({ method: 'get', path: '/api/status', headers: {}, bodyBase64: '' });
  assert.deepEqual(JSON.parse(json), {
    method: 'GET',
    path: '/api/status',
    headers: {},
    body_base64: '',
  });
});

test('encodeRequest rejects methods, paths and oversized bodies', () => {
  assert.throws(() => encodeRequest({ method: 'TRACE', path: '/' }));
  assert.throws(() => encodeRequest({ method: 'GET', path: '/../etc' }));
  assert.throws(() => encodeRequest({ method: 'GET', path: 'https://evil/' }));
  assert.throws(() => encodeRequest({ method: 'GET', path: '/%2e%2e/x' }));
  assert.throws(() => encodeRequest({ method: 'GET', path: '' }));
  assert.throws(() =>
    encodeRequest({ method: 'POST', path: '/', bodyBase64: 'A'.repeat(100 * 1024) }),
  );
  assert.doesNotThrow(() => encodeRequest({ path: '/' }));
});

test('decodeResponse validates the reply shape', () => {
  const good = decodeResponse('{"status":200,"headers":{"content-type":"text/html"},"body_base64":"eA==","error":null}');
  assert.equal(good.status, 200);
  assert.equal(good.bodyBase64, 'eA==');
  assert.equal(good.error, null);

  for (const bad of [
    'not json',
    '[]',
    '{"status":99,"body_base64":""}',
    '{"status":200}',
    '{"status":200,"body_base64":"","headers":[]}',
  ]) {
    assert.throws(() => decodeResponse(bad), `must reject ${bad}`);
  }
});

test('parseNymAddress accepts both forms and rejects garbage', () => {
  const a = 'idPart.encPart@gwPart';
  assert.deepEqual(parseNymAddress(a), { identity: 'idPart', encryption: 'encPart', gateway: 'gwPart' });
  assert.deepEqual(parseNymAddress(`nym://${a}`), {
    identity: 'idPart',
    encryption: 'encPart',
    gateway: 'gwPart',
  });
  for (const bad of ['', 'nope', 'a.b', 'a.b@c.d', 'nym://a.b']) {
    assert.throws(() => parseNymAddress(bad), `must reject ${bad}`);
  }
});

test('resolvePetname prefers the local registry, never the network', () => {
  const registry = { shop: 'AAA.BBB@CCC' };
  assert.equal(resolvePetname('SHOP', registry), 'AAA.BBB@CCC');
  assert.equal(resolvePetname('  shop  ', registry), 'AAA.BBB@CCC');
  assert.equal(resolvePetname('AAA.BBB@CCC', registry), 'AAA.BBB@CCC');
  assert.throws(() => resolvePetname('unknown', registry));
});

test('splitNymUri separates address and path', () => {
  const addr = 'ID.ENC@GW';
  assert.deepEqual(splitNymUri(addr), { address: addr, path: '/' });
  assert.deepEqual(splitNymUri(`nym://${addr}`), { address: addr, path: '/' });
  assert.deepEqual(splitNymUri(`${addr}/api/status`), { address: addr, path: '/api/status' });
  assert.deepEqual(splitNymUri(`nym://${addr}/a?x=1#frag`), { address: addr, path: '/a?x=1' });
  assert.deepEqual(splitNymUri(`  ${addr}  `), { address: addr, path: '/' });
  for (const bad of ['', 'nope', `${addr}/../etc`, 'nym://a.b']) {
    assert.throws(() => splitNymUri(bad), `must reject ${bad}`);
  }
});

test('base58 decodes known values and rejects non-alphabet', () => {
  const bytes = base58Decode('StV1DL6CwTryKyV');
  assert.ok(bytes.length > 0);
  assert.throws(() => base58Decode('0OIl'));
  assert.throws(() => base58Decode(''));
});

test('invite compact form round-trips', () => {
  const invite = {
    service: 'nym://ID.ENC@GW',
    inviter: 'ab'.repeat(32),
    note: 'join my portal',
    sig: 'cd'.repeat(64),
  };
  const compact = encodeInviteCompact(invite);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(compact));
  assert.deepEqual(decodeInviteCompact(compact), invite);
  assert.throws(() => decodeInviteCompact('!!!'));
  assert.throws(() => decodeInviteCompact('e30=')); // {} — missing fields
});

test('invite compact form round-trips vouches and rejects bad shapes', () => {
  const base = {
    service: 'nym://ID.ENC@GW',
    inviter: 'ab'.repeat(32),
    note: 'join my portal',
    sig: 'cd'.repeat(64),
  };
  const vouched = { ...base, vouches: ['ef'.repeat(32), '01'.repeat(32)] };
  assert.deepEqual(decodeInviteCompact(encodeInviteCompact(vouched)), vouched);
  // No vouches key in, none out (legacy shape preserved).
  assert.deepEqual(decodeInviteCompact(encodeInviteCompact(base)), base);
  const bad = [
    { ...base, vouches: 'nope' },
    { ...base, vouches: ['xyz'] },
    { ...base, vouches: ['ab'.repeat(33)] },
    { ...base, vouches: Array.from({ length: 9 }, () => 'ab'.repeat(32)) },
  ];
  for (const invite of bad) {
    assert.throws(() => encodeInviteCompact(invite), /vouches/);
  }
});

test('parseInviteLink separates address, path and invite', () => {
  const addr = 'ID.ENC@GW';
  const invite = encodeInviteCompact({
    service: `nym://${addr}`,
    inviter: 'ab'.repeat(32),
    note: 'hi',
    sig: 'cd'.repeat(64),
  });
  const plain = parseInviteLink(addr);
  assert.deepEqual(plain, { address: addr, path: '/', invite: null });
  const full = parseInviteLink(`nym://${addr}/feed?a=1#invite=${invite}`);
  assert.equal(full.address, addr);
  assert.equal(full.path, '/feed?a=1');
  assert.equal(full.invite.note, 'hi');
  // Bait-and-switch: invite naming another service is refused.
  const other = encodeInviteCompact({
    service: 'nym://XX.YY@ZZ',
    inviter: 'ab'.repeat(32),
    note: 'hi',
    sig: 'cd'.repeat(64),
  });
  assert.throws(() => parseInviteLink(`${addr}#invite=${other}`));
  assert.throws(() => parseInviteLink(`${addr}#other=1`));
});

test('checkPath mirrors the bridge guards', () => {
  assert.equal(checkPath('/a/b?x=1'), '/a/b?x=1');
  for (const bad of ['/..', '/a/../../b', '//host', '/a\\b', '/x%5c..']) {
    assert.throws(() => checkPath(bad), `must reject ${bad}`);
  }
});
