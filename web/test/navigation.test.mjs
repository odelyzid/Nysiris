// Run with: node --test web/test
// Address resolution for the unified browser bar (nym:// + http(s)).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalNymUrl,
  isClearnetInput,
  resolveNavigationInput,
  targetLabel,
} from '../src/application/navigation.ts';

const NYM =
  '6BH3ALNQ9L39qsei6QjofNcRRdFydoq82UJ2KE3XTZnq.6vdcFysfmE4yXqsgn3hd2uPPpoE5kvkvot4tYqWWhvKJ@CcYinhLeFU8n6xs78FG6Rz3wvosGTCU2hLB1CZyfkMVe';

test('resolves bare and schemed Nym addresses', () => {
  const bare = resolveNavigationInput(NYM);
  assert.equal(bare.kind, 'nym');
  assert.equal(bare.address, NYM);
  assert.equal(bare.path, '/');
  assert.equal(bare.url, `nym://${NYM}/`);
  assert.equal(bare.invite, null);

  const withPath = resolveNavigationInput(`nym://${NYM}/wiki/index`);
  assert.equal(withPath.kind, 'nym');
  assert.equal(withPath.path, '/wiki/index');
  assert.equal(withPath.url, `nym://${NYM}/wiki/index`);

  const uppercase = resolveNavigationInput(`NYM://${NYM}/`);
  assert.equal(uppercase.kind, 'nym');
  assert.equal(uppercase.url, `nym://${NYM}/`);
});

test('canonical Nym URL normalises a missing leading slash', () => {
  assert.equal(canonicalNymUrl(NYM, 'path'), `nym://${NYM}/path`);
  assert.equal(canonicalNymUrl(NYM), `nym://${NYM}/`);
});

test('resolves http(s) URLs and keeps path/query', () => {
  const target = resolveNavigationInput('https://example.com/a/b?q=1#frag');
  assert.equal(target.kind, 'clearnet');
  assert.equal(target.address, 'https://example.com');
  assert.equal(target.path, '/a/b?q=1');
  assert.equal(target.url, 'https://example.com/a/b?q=1#frag');
  assert.equal(target.invite, null);
  assert.equal(targetLabel(target), 'https://example.com');
});

test('expands petnames case-insensitively', () => {
  const target = resolveNavigationInput('Alice', { petnames: { alice: `nym://${NYM}/notes` } });
  assert.equal(target.kind, 'nym');
  assert.equal(target.address, NYM);
  assert.equal(target.path, '/notes');
  // Unknown names are still parsed as addresses so the error is honest.
  assert.throws(() => resolveNavigationInput('bob', { petnames: { alice: NYM } }), /not a nym address/);
});

test('rejects unsupported schemes and garbage', () => {
  for (const input of [
    '',
    '   ',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,hi',
    'ftp://example.com',
  ]) {
    assert.throws(() => resolveNavigationInput(input), /address|supported|URL/, input);
  }
});

test('recognises clearnet input for UI hints', () => {
  assert.equal(isClearnetInput('HTTPS://example.com'), true);
  assert.equal(isClearnetInput(`nym://${NYM}`), false);
});
