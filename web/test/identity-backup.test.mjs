// Run with: node --test web/test
// Encrypted identity backup: round-trip, wrong password, malformed files.
// Skips cleanly when node_modules are absent (offline `./build.sh check`).
import test from 'node:test';
import assert from 'node:assert/strict';

let identity = null;
try {
  identity = await import('../src/social/identity.ts');
} catch {
  identity = null;
}

test('backup round-trips and adopts the identity', { skip: !identity }, async () => {
  const id = identity.createIdentity();
  const json = await identity.exportIdentityBackup(id.privHex, 'correct horse 123');
  const parsed = JSON.parse(json);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.kdf, 'argon2id');
  assert.ok(!json.includes(id.privHex.slice(0, 16)));

  const restored = await identity.importIdentityBackup(json, 'correct horse 123');
  assert.equal(restored.pubHex, id.pubHex);
  assert.equal(restored.privHex, id.privHex);
});

test('wrong password and tampered files fail closed', { skip: !identity }, async () => {
  const id = identity.createIdentity();
  const json = await identity.exportIdentityBackup(id.privHex, 'correct horse 123');
  await assert.rejects(() => identity.importIdentityBackup(json, 'wrong password!'), /password wrong or file corrupted/);

  const tampered = { ...JSON.parse(json), ctB64: Buffer.from('x'.repeat(48)).toString('base64') };
  await assert.rejects(() => identity.importIdentityBackup(JSON.stringify(tampered), 'correct horse 123'));
});

test('weak passwords and malformed backups are rejected', { skip: !identity }, async () => {
  const id = identity.createIdentity();
  await assert.rejects(() => identity.exportIdentityBackup(id.privHex, 'short'), /at least 8/);
  await assert.rejects(() => identity.exportIdentityBackup('xyz', 'long enough password'), /32 bytes/);

  const good = JSON.parse(await identity.exportIdentityBackup(id.privHex, 'long enough password'));
  const cases = [
    ['not json', 'valid JSON'],
    [[], 'must be an object'],
    [{ ...good, v: 2 }, 'unsupported backup version'],
    [{ ...good, kdf: 'scrypt' }, 'unsupported backup version'],
    [{ ...good, m: 1024 * 1024 }, 'unsafe m'],
    [{ ...good, t: 99 }, 'unsafe t'],
    [{ ...good, saltB64: '!!!' }, 'not valid base64'],
    [{ ...good, saltB64: Buffer.from('short').toString('base64') }, 'wrong shape'],
  ];
  for (const [input, pattern] of cases) {
    await assert.rejects(
      () => identity.importIdentityBackup(typeof input === 'string' ? input : JSON.stringify(input), 'long enough password'),
      new RegExp(pattern),
    );
  }
});
