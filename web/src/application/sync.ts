/**
 * Partial-replica sync helpers for the community timeline.
 *
 * Opening a portal pulls the recent posts you don't have yet
 * (`GET /feed?since=<cursor>&limit=<n>`), oldest-first, deduplicated by
 * sequence number. Everything here is pure logic so it runs under
 * `node --test web/test` with no browser.
 */

export interface FeedPost {
  seq: number;
}

/** Cap on kept posts: recent history, not an archive. */
export const MAX_KEPT_POSTS = 200;

/**
 * Merge freshly fetched posts into what we already show: drop duplicates
 * by `seq`, keep ascending order, cap the tail. Never mutates inputs.
 */
export function mergeFeedPosts<T extends FeedPost>(prev: T[], incoming: T[]): T[] {
  const seen = new Set(prev.map((p) => p.seq));
  const merged = [...prev];
  for (const p of incoming) {
    if (typeof p.seq !== 'number' || seen.has(p.seq)) continue;
    seen.add(p.seq);
    merged.push(p);
  }
  merged.sort((a, b) => a.seq - b.seq);
  return merged.length > MAX_KEPT_POSTS ? merged.slice(merged.length - MAX_KEPT_POSTS) : merged;
}

export interface SyncState {
  syncing: boolean;
  lastSyncedAt: number | null;
  error: string | null;
}

/** One friendly line for the sync status under the timeline. */
export function describeSync(now: number, state: SyncState): { text: string; tone: 'ok' | 'busy' | 'bad' | 'idle' } {
  if (state.syncing) return { text: 'Syncing… pulling recent posts.', tone: 'busy' };
  if (state.error) return { text: `Couldn't reach the community. ${state.error}`, tone: 'bad' };
  if (state.lastSyncedAt === null) return { text: 'Not synced yet.', tone: 'idle' };
  const ageMs = Math.max(0, now - state.lastSyncedAt);
  if (ageMs < 15_000) return { text: 'Up to date — checked just now.', tone: 'ok' };
  if (ageMs < 60_000) return { text: `Up to date — checked ${Math.floor(ageMs / 1000)}s ago.`, tone: 'ok' };
  return { text: `Last checked ${Math.floor(ageMs / 60_000)}m ago.`, tone: 'ok' };
}
