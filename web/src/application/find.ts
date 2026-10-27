/**
 * Find-in-page matching.
 *
 * The shell has two document surfaces: a sanitised HTML iframe and a plain
 * text/JSON `<pre>`. Matching itself is pure so the same rules (case-insensitive,
 * non-overlapping, bounded) apply to both. DOM wrapping lives in the shell.
 */

export interface FindMatch {
  /** Start offset in the searched string. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

export interface FindOptions {
  /** Safety cap; a pathological page should not freeze the renderer. */
  limit?: number;
}

export const DEFAULT_FIND_LIMIT = 500;

export function findMatches(text: string, query: string, options: FindOptions = {}): FindMatch[] {
  const haystack = String(text ?? '');
  const needle = String(query ?? '');
  if (!needle || needle.trim().length === 0 || haystack.length === 0) return [];
  const limit = Math.max(1, options.limit ?? DEFAULT_FIND_LIMIT);
  const lowerHaystack = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const matches: FindMatch[] = [];
  let from = 0;
  while (matches.length < limit) {
    const index = lowerHaystack.indexOf(lowerNeedle, from);
    if (index === -1) break;
    matches.push({ start: index, end: index + needle.length });
    // Non-overlapping: advance past this match. `+1` also guarantees progress
    // for an empty needle, which is rejected above anyway.
    from = index + Math.max(1, needle.length);
  }
  return matches;
}

export interface HighlightSegment {
  text: string;
  match: boolean;
  /** Index into the match list (only for `match` segments). */
  index?: number;
}

/** Split text into alternating plain/highlight segments for the `<pre>` view. */
export function highlightSegments(text: string, matches: FindMatch[]): HighlightSegment[] {
  const source = String(text ?? '');
  const out: HighlightSegment[] = [];
  let cursor = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (match.start < cursor || match.start > source.length || match.end > source.length) continue;
    if (match.start > cursor) out.push({ text: source.slice(cursor, match.start), match: false });
    out.push({ text: source.slice(match.start, match.end), match: true, index });
    cursor = match.end;
  }
  if (cursor < source.length) out.push({ text: source.slice(cursor), match: false });
  return out;
}

/** Wrap the current match index so next/previous cycle at the ends. */
export function cycleMatch(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return direction > 0 ? 0 : count - 1;
  return (current + direction + count) % count;
}
