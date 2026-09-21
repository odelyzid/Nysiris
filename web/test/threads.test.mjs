// Run with: node --test web/test
// Thread assembly basics, deep-link hash codec, and gap-fetch budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_GAP_FETCH_ATTEMPTS,
  buildThread,
  clearGapAttempt,
  countDescendants,
  formatThreadHash,
  missingAncestors,
  noteGapAttempt,
  parseThreadHash,
} from '../src/social/threads.ts';

const node = (id, inReplyTo, seq) => ({ id, inReplyTo, seq });
const byId = (list) => new Map(list.map((p) => [p.id, p]));

test('buildThread assembles root plus transitive descendants oldest-first', () => {
  const posts = [
    node('root', null, 3),
    node('r1', 'root', 5),
    node('r2', 'root', 4),
    node('r1a', 'r1', 6),
    node('other', null, 7),
  ];
  const t = buildThread('root', byId(posts));
  assert.equal(t.root.id, 'root');
  assert.deepEqual(t.replies.map((r) => r.id), ['r2', 'r1', 'r1a']);
  assert.deepEqual(t.missing, []);
  assert.equal(countDescendants('root', byId(posts)), 3);
});

test('buildThread reports missing roots and terminates on cycles', () => {
  const posts = [
    node('a', 'ghost', 1),
    node('self', 'self', 2),
    node('x', 'y', 3),
    node('y', 'x', 4),
  ];
  const map = byId(posts);
  const unknown = buildThread('nope', map);
  assert.equal(unknown.root, null);
  assert.deepEqual(unknown.missing, ['nope']);

  // Ancestor above a known root is reported for fetching.
  assert.deepEqual(buildThread('a', map).missing, ['ghost']);
  // Self-parent and 2-cycles terminate via the claimed set.
  assert.equal(buildThread('self', map).replies.length, 0);
  assert.ok(buildThread('x', map).replies.length <= 2);
  assert.deepEqual(missingAncestors(['ghost'], map), ['ghost']);
});

test('thread hash codec round-trips and rejects garbage', () => {
  const id = 'ab'.repeat(16);
  assert.equal(formatThreadHash(id), `#thread=${id}`);
  assert.equal(parseThreadHash(`#thread=${id}`), id);
  assert.equal(parseThreadHash(`#thread=${id.toUpperCase()}`), id);
  for (const bad of ['', '#thread=', '#thread=xyz', '#thread=ab', `#thread=${'ab'.repeat(17)}`, '#invite=abc', null, undefined, 42, '#thread=ab!'.repeat(8)]) {
    assert.equal(parseThreadHash(bad), null, JSON.stringify(bad));
  }
});

test('gap budget exhausts after MAX_GAP_FETCH_ATTEMPTS and never mutates', () => {
  let attempts = {};
  for (let i = 1; i < MAX_GAP_FETCH_ATTEMPTS; i += 1) {
    const step = noteGapAttempt(attempts, 'dead');
    assert.equal(step.exhausted, false);
    attempts = step.attempts;
  }
  const last = noteGapAttempt(attempts, 'dead');
  assert.equal(last.exhausted, true);
  assert.equal(last.attempts.dead, MAX_GAP_FETCH_ATTEMPTS);
  // Earlier snapshot untouched.
  assert.equal(attempts.dead, MAX_GAP_FETCH_ATTEMPTS - 1);

  // Independent ids have independent budgets.
  assert.equal(noteGapAttempt(last.attempts, 'other').exhausted, false);

  const cleared = clearGapAttempt(last.attempts, 'dead');
  assert.ok(!('dead' in cleared));
  assert.ok('dead' in last.attempts);
  assert.equal(clearGapAttempt(cleared, 'missing'), cleared);
});
