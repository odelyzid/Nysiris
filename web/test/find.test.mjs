// Run with: node --test web/test
// Find-in-page matching, highlighting segments, and wraparound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FIND_LIMIT, cycleMatch, findMatches, highlightSegments } from '../src/application/find.ts';

test('finds case-insensitive non-overlapping matches', () => {
  assert.deepEqual(findMatches('Nym nym NYM', 'nym'), [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
    { start: 8, end: 11 },
  ]);
  assert.deepEqual(findMatches('aaaa', 'aa'), [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
  assert.deepEqual(findMatches('abc', 'abc'), [{ start: 0, end: 3 }]);
});

test('ignores empty/whitespace queries and caps results', () => {
  assert.deepEqual(findMatches('abc', ''), []);
  assert.deepEqual(findMatches('abc', '   '), []);
  assert.deepEqual(findMatches('', 'a'), []);
  assert.equal(findMatches('a'.repeat(1000), 'a', { limit: 7 }).length, 7);
  assert.equal(findMatches('a'.repeat(DEFAULT_FIND_LIMIT + 5), 'a').length, DEFAULT_FIND_LIMIT);
});

test('highlightSegments alternates plain and matched runs', () => {
  const segments = highlightSegments('one two one', findMatches('one two one', 'one'));
  assert.deepEqual(
    segments.map((segment) => [segment.text, segment.match]),
    [
      ['one', true],
      [' two ', false],
      ['one', true],
    ],
  );
  assert.deepEqual(highlightSegments('plain', []), [{ text: 'plain', match: false }]);
});

test('cycleMatch wraps and starts at the right end', () => {
  assert.equal(cycleMatch(-1, 3, 1), 0);
  assert.equal(cycleMatch(-1, 3, -1), 2);
  assert.equal(cycleMatch(2, 3, 1), 0);
  assert.equal(cycleMatch(0, 3, -1), 2);
  assert.equal(cycleMatch(0, 0, 1), -1);
});
