/**
 * Client-side thread assembly for nysiris replies.
 *
 * The provider stores each post's `in_reply_to` parent id opaquely and never
 * assembles threads — every structure here is built in the browser from the
 * partial replica (`posts` state). v1 renders one level: root on top, all
 * transitive descendants in chronological (seq) order underneath.
 *
 * Pure logic (no browser globals): unit-testable with
 * `node --test web/test`. Cycle-safe and depth-bounded so hostile data can
 * only cost bounded work.
 */

export interface ThreadNode {
  /** Stable post id (hex). */
  id: string;
  /** Parent post id, or null for a top-level post. */
  inReplyTo: string | null;
  /** Server sequence: the chronological order. */
  seq: number;
}

/** Hard cap on ancestor-chain walks (cycle + depth safety). */
export const MAX_THREAD_DEPTH = 25;

/**
 * Deep-link hash for a thread: `#thread=<16-byte post id hex>`. Opening the
 * app with this hash lands in the thread (once the community is open).
 */
export function formatThreadHash(rootId: string): string {
  return `#thread=${rootId}`;
}

/** Parse a location hash into a thread root id. Null on any garbage. */
export function parseThreadHash(hash: unknown): string | null {
  if (typeof hash !== 'string') return null;
  const m = /^#thread=([0-9a-fA-F]{32})$/.exec(hash.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Max fetch attempts per missing post before it is marked unavailable.
 * Failed gap fills retry (the effect re-runs when in-flight state clears),
 * so without a budget a dead id spins one mixnet roundtrip per cycle
 * forever while its thread stays open.
 */
export const MAX_GAP_FETCH_ATTEMPTS = 3;

/** Record one failed fetch; `exhausted` when the budget is spent. Never mutates. */
export function noteGapAttempt(
  attempts: Record<string, number>,
  id: string,
): { attempts: Record<string, number>; exhausted: boolean } {
  const count = (attempts[id] ?? 0) + 1;
  return { attempts: { ...attempts, [id]: count }, exhausted: count >= MAX_GAP_FETCH_ATTEMPTS };
}

/** Drop the counter after a successful fetch. Never mutates. */
export function clearGapAttempt(attempts: Record<string, number>, id: string): Record<string, number> {
  if (!(id in attempts)) return attempts;
  const next = { ...attempts };
  delete next[id];
  return next;
}

export interface BuiltThread<T extends ThreadNode> {
  /** The root post, or null when it isn't in the local replica yet. */
  root: T | null;
  /** Transitive descendants of the root, oldest first. */
  replies: T[];
  /** Ancestor ids referenced but missing locally (oldest gap first). */
  missing: string[];
}

function keyOf(id: unknown): string | null {
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Assemble the thread for `rootId` from the posts we already have.
 * Unknown root → `{ root: null, replies: [], missing: [rootId] }` so the
 * caller knows to fetch it.
 */
export function buildThread<T extends ThreadNode>(rootId: string, byId: ReadonlyMap<string, T>): BuiltThread<T> {
  const root = byId.get(rootId) ?? null;
  if (!root) return { root: null, replies: [], missing: [rootId] };

  // Transitive descendants, chronological. Cycle-safe: a post already
  // claimed by this thread is never revisited.
  const claimed = new Set<string>([rootId]);
  const replies: T[] = [];
  let frontier: T[] = [root];
  for (let depth = 0; depth < MAX_THREAD_DEPTH && frontier.length > 0; depth += 1) {
    const parents = new Set(frontier.map((p) => p.id));
    const children: T[] = [];
    for (const post of byId.values()) {
      const parent = keyOf(post.inReplyTo);
      if (parent && parents.has(parent) && !claimed.has(post.id)) {
        claimed.add(post.id);
        children.push(post);
      }
    }
    children.sort((a, b) => a.seq - b.seq);
    replies.push(...children);
    frontier = children;
  }
  replies.sort((a, b) => a.seq - b.seq);

  // Ancestor gaps above the root (walk up; the chain ends at a top-level
  // post or a missing id). Returned oldest-gap-first for fetch order.
  const missing = missingAncestors([rootId], byId);
  return { root, replies, missing };
}

/** Direct replies to one post, oldest first. */
export function directReplies<T extends ThreadNode>(parentId: string, posts: Iterable<T>): T[] {
  const out: T[] = [];
  for (const post of posts) {
    if (keyOf(post.inReplyTo) === parentId) out.push(post);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/** Transitive descendant count (what the timeline "N replies" pill shows). */
export function countDescendants<T extends ThreadNode>(parentId: string, byId: ReadonlyMap<string, T>): number {
  const seen = new Set<string>();
  let frontier = [parentId];
  for (let depth = 0; depth < MAX_THREAD_DEPTH && frontier.length > 0; depth += 1) {
    const parents = new Set(frontier);
    frontier = [];
    for (const post of byId.values()) {
      const parent = keyOf(post.inReplyTo);
      if (parent && parents.has(parent) && !seen.has(post.id)) {
        seen.add(post.id);
        frontier.push(post.id);
      }
    }
  }
  // A cycle can walk back to the queried node itself; it is not its own
  // descendant.
  seen.delete(parentId);
  return seen.size;
}

/**
 * Ancestor ids referenced by `startIds` (or their chain) but absent from
 * the local map. Oldest gap first, duplicates removed, depth-bounded.
 */
export function missingAncestors<T extends ThreadNode>(
  startIds: Iterable<string>,
  byId: ReadonlyMap<string, T>,
): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const start of startIds) {
    let current: string | null = start;
    for (let depth = 0; depth < MAX_THREAD_DEPTH && current; depth += 1) {
      if (seen.has(current)) break;
      seen.add(current);
      const post = byId.get(current);
      if (!post) {
        if (!missing.includes(current)) missing.push(current);
        break;
      }
      current = keyOf(post.inReplyTo);
    }
  }
  return missing;
}

/** Normalize a feed item's parent field: hex string or null. */
export function normalizeParent(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}
