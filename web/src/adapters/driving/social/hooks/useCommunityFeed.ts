import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchNym } from '../../../../mixnet/fetchNym';
import { createReputation } from '../../../../mixnet/reputation.mjs';
import { currentDay, verifyPostSignature } from '../../../../domain/identity';
import {
  MAX_GAP_FETCH_ATTEMPTS,
  buildThread,
  clearGapAttempt,
  formatThreadHash,
  missingAncestors,
  normalizeParent,
  noteGapAttempt,
  parseThreadHash,
  type BuiltThread,
  type ThreadNode,
} from '../../../../domain/threads';
import { parseAttachmentRefs } from '../../../../domain/attachments.mjs';
import { mergeFeedPosts } from '../../../../application/sync';
import { copyText } from '../../../../shared/share';
import type { SocialTab } from '../../../../application/tabs';
import type { AttachmentRef } from '../../../../domain/attachmentCrypto';
import type { Standing } from '../../../../domain/trust';
import type { FeedReply, Post } from '../model';

export interface CommunityFeed {
  posts: Post[];
  topLevelPosts: Post[];
  postsById: Map<string, Post>;
  threadNodes: Map<string, ThreadNode>;
  activeThread: BuiltThread<ThreadNode> | null;
  activeThreadMissingIds: string[];
  syncing: boolean;
  lastSyncedAt: number | null;
  feedError: string | null;
  nowTick: number;
  oldestSeq: number;
  loadingOlder: boolean;
  openThreadId: string | null;
  fetchingIds: string[];
  unavailableIds: string[];
  names: Record<string, string>;
  refreshFeed: () => Promise<void>;
  loadOlder: () => Promise<void>;
  showThread: (id: string) => void;
  closeThread: () => void;
  shareThreadLink: () => void;
  onLookup: (author: string) => Promise<void>;
  standingOf: (author: string) => Standing;
}

/**
 * Partial-replica feed + local thread assembly: fetching, signature
 * verification, reputation observations, polling, and deep-link handling.
 * All provider access goes through the injected `fetchNym` client.
 */
export function useCommunityFeed({
  service,
  append,
  onSelectTab,
}: {
  service: string;
  append: (line: string) => void;
  onSelectTab: (next: SocialTab) => void;
}): CommunityFeed {
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState(0);
  const [names, setNames] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [fetchingIds, setFetchingIds] = useState<string[]>([]);
  const [unavailableIds, setUnavailableIds] = useState<string[]>([]);
  const cursorRef = useRef(0);
  cursorRef.current = cursor;

  const postsById = useMemo(() => new Map(posts.map((p) => [p.id, p])), [posts]);

  /** Minimal thread shape adapted from feed posts for `threads.ts`. */
  const threadNodes = useMemo(
    () => new Map(posts.map((p) => [p.id, { id: p.id, inReplyTo: normalizeParent(p.in_reply_to), seq: p.seq }])),
    [posts],
  );

  // Local reputation: first-hand observations only, persisted locally.
  // Unknown authors start unseen; forged posts never render.
  const repRef = useRef<ReturnType<typeof createReputation> | null>(null);
  if (!repRef.current) {
    const rep = createReputation();
    try {
      rep.load(JSON.parse(localStorage.getItem('fly.reputation') ?? '[]'), currentDay());
    } catch {
      // Corrupt store: start fresh rather than crash.
    }
    repRef.current = rep;
  }
  const [, setRepTick] = useState(0);
  const recordRep = useCallback(
    (author: string, kind: 'valid' | 'duplicate' | 'undecryptable' | 'invalidSignature' | 'equivocation') => {
      repRef.current?.observe(author, kind, currentDay());
      try {
        localStorage.setItem('fly.reputation', JSON.stringify(repRef.current?.toJSON() ?? []));
      } catch {
        // Private mode: scores just don't persist.
      }
      setRepTick((t) => t + 1);
    },
    [],
  );

  const standingOf = useCallback(
    (author: string): Standing => repRef.current?.standing(author, currentDay()) ?? 'unknown',
    [],
  );

  /**
   * Verify one feed item's signature before it renders: forged posts never
   * show, and the observation feeds local reputation (first-hand only). The
   * parent id and attachment refs are part of the signed bytes; malformed
   * attachments drop the post fail-closed.
   */
  const checkPost = useCallback(
    (p: Post): boolean => {
      const parent = normalizeParent(p.in_reply_to);
      let atts: AttachmentRef[] = [];
      try {
        atts = parseAttachmentRefs(p.attachments);
      } catch {
        recordRep(p.author, 'invalidSignature');
        append(`post with bad attachments dropped (seq ${p.seq})`);
        return false;
      }
      const ok = verifyPostSignature(p.author, p.day, new TextEncoder().encode(p.body), p.sig, parent, atts);
      recordRep(p.author, ok ? 'valid' : 'invalidSignature');
      if (!ok) append(`forged post dropped (seq ${p.seq})`);
      return ok;
    },
    [append, recordRep],
  );

  /** Fetch one post by id to fill a thread gap. Verifies before merging. */
  const fetchPostByIdInner = useCallback(
    async (id: string): Promise<void> => {
      if (!service) return;
      setFetchingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      try {
        const res = await fetchNym(service, { method: 'GET', path: `/post/${id}` });
        if (res.error) {
          setUnavailableIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
          return;
        }
        const item = JSON.parse(new TextDecoder().decode(res.body)) as Post;
        if (!checkPost(item)) {
          setUnavailableIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
          return;
        }
        gapAttemptsRef.current = clearGapAttempt(gapAttemptsRef.current, id);
        setPosts((prev) => mergeFeedPosts(prev, [item]));
      } catch (err) {
        // Transport failure (not a definitive 404): retry until the per-id
        // budget is spent, then mark unavailable so the poller stops.
        const step = noteGapAttempt(gapAttemptsRef.current, id);
        gapAttemptsRef.current = step.attempts;
        if (step.exhausted) {
          gapAttemptsRef.current = clearGapAttempt(gapAttemptsRef.current, id);
          setUnavailableIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
          append(`post ${id.slice(0, 12)}… unavailable after ${MAX_GAP_FETCH_ATTEMPTS} tries`);
        } else {
          append(`post fetch failed: ${String(err)}`);
        }
      } finally {
        setFetchingIds((prev) => prev.filter((x) => x !== id));
      }
    },
    [service, append, checkPost],
  );

  // Gap fills share the single client; queue them instead of firing one
  // request per missing id in parallel.
  const gapChainRef = useRef<Promise<void>>(Promise.resolve());
  // Consecutive transport failures per missing id (reset on success and on
  // service switch). Spending the budget marks the id unavailable.
  const gapAttemptsRef = useRef<Record<string, number>>({});
  const fetchPostById = useCallback(
    (id: string): Promise<void> => {
      const task = gapChainRef.current.then(() => fetchPostByIdInner(id));
      gapChainRef.current = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
    [fetchPostByIdInner],
  );

  /** Open a thread. Missing ancestors are pulled by the effect below. */
  const showThread = useCallback(
    (id: string) => {
      setOpenThreadId(id);
      onSelectTab('timeline');
      try {
        window.location.hash = formatThreadHash(id);
      } catch {
        // Non-browser context: the thread still opens, just without a link.
      }
    },
    [onSelectTab],
  );

  /** Close the open thread and drop its deep-link. */
  const closeThread = useCallback(() => {
    setOpenThreadId(null);
    try {
      if (parseThreadHash(window.location.hash)) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    } catch {
      // Non-browser context: nothing to clear.
    }
  }, []);

  // Deep-links: `#thread=<id>` opens a thread on load and on hash change
  // (e.g. pasting a thread link while the app is open). replaceState above
  // does not fire hashchange, so closing never loops back open.
  useEffect(() => {
    const applyHash = () => {
      let id: string | null = null;
      try {
        id = parseThreadHash(window.location.hash);
      } catch {
        id = null;
      }
      if (id) {
        setOpenThreadId(id);
        onSelectTab('timeline');
      }
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, [onSelectTab]);

  /** The open thread, reassembled from the local replica on every sync. */
  const activeThread = useMemo(
    () => (openThreadId ? buildThread(openThreadId, threadNodes) : null),
    [openThreadId, threadNodes],
  );

  /** All ancestor gaps for the open thread, root chain plus every reply chain. */
  const activeThreadMissingIds = useMemo(() => {
    if (!activeThread) return [];
    const ids = new Set<string>(activeThread.missing);
    for (const reply of activeThread.replies) {
      for (const mid of missingAncestors([reply.id], threadNodes)) ids.add(mid);
    }
    return [...ids];
  }, [activeThread, threadNodes]);

  // Fill thread gaps as the replica grows: the root chain plus every known
  // reply's chain is walked, and missing ids are pulled one at a time.
  // Guards make this terminate: fetched ids merge into the map, failed ids
  // land in `unavailableIds`, in-flight ids in `fetchingIds`.
  useEffect(() => {
    if (!openThreadId || !activeThread) return;
    const ids = new Set<string>(activeThread.missing);
    for (const reply of activeThread.replies) {
      for (const mid of missingAncestors([reply.id], threadNodes)) ids.add(mid);
    }
    for (const mid of ids) {
      if (!fetchingIds.includes(mid) && !unavailableIds.includes(mid)) {
        void fetchPostById(mid);
      }
    }
  }, [openThreadId, activeThread, threadNodes, fetchingIds, unavailableIds, fetchPostById]);

  const refreshFeed = useCallback(async () => {
    if (!service) return;
    setSyncing(true);
    setFeedError(null);
    try {
      let since = cursorRef.current;
      if (since === 0) {
        // First sync starts at recent history, not genesis: the feed is
        // oldest-first, so since=0 would walk the entire archive 20 posts
        // per mixnet roundtrip before showing anything new.
        try {
          const health = await fetchNym(service, { method: 'GET', path: '/health' });
          if (!health.error) {
            const seq = (JSON.parse(new TextDecoder().decode(health.body)) as { seq?: unknown }).seq;
            if (typeof seq === 'number' && Number.isFinite(seq) && seq > 20) {
              since = Math.floor(seq) - 20;
            }
          }
        } catch {
          // Fall through to since=0.
        }
      }
      const res = await fetchNym(service, {
        method: 'GET',
        path: `/feed?since=${since}&limit=20`,
      });
      if (res.error) {
        setFeedError(res.error);
        append(`feed error: ${res.error}`);
        return;
      }
      const feed = JSON.parse(new TextDecoder().decode(res.body)) as FeedReply;
      if (feed.posts.length > 0) {
        const verified = feed.posts.filter(checkPost);
        if (verified.length > 0) {
          setPosts((prev) => mergeFeedPosts(prev, verified));
          setCursor(feed.next);
        }
      }
      setLastSyncedAt(Date.now());
      setNowTick(Date.now());
    } catch (err) {
      const msg = String(err);
      setFeedError(msg);
      append(`feed failed: ${msg}`);
    } finally {
      setSyncing(false);
    }
  }, [service, append, checkPost]);

  /** Oldest seq held locally (Infinity when empty): the "load older" anchor. */
  const oldestSeq = useMemo(() => posts.reduce((min, p) => Math.min(min, p.seq), Number.POSITIVE_INFINITY), [posts]);

  /**
   * Page backwards into history the feed route cannot express: fetch the
   * window ending at the oldest known post and keep only what is older.
   */
  const loadOlder = useCallback(async () => {
    if (!service || loadingOlder) return;
    if (!Number.isFinite(oldestSeq) || oldestSeq <= 1) return;
    setLoadingOlder(true);
    try {
      const res = await fetchNym(service, {
        method: 'GET',
        path: `/feed?since=${Math.max(0, oldestSeq - 60)}&limit=50`,
      });
      if (res.error) {
        append(`older posts error: ${res.error}`);
        return;
      }
      const feed = JSON.parse(new TextDecoder().decode(res.body)) as FeedReply;
      const verified = feed.posts.filter((p) => p.seq < oldestSeq).filter(checkPost);
      if (verified.length > 0) {
        setPosts((prev) => mergeFeedPosts(prev, verified));
      } else {
        append('no older posts on this community');
      }
    } catch (err) {
      append(`older posts failed: ${String(err)}`);
    } finally {
      setLoadingOlder(false);
    }
  }, [service, loadingOlder, oldestSeq, checkPost, append]);

  // A new service means a new timeline: drop cached posts and cursor. A
  // thread deep-link survives the switch (it re-opens once the new
  // community's posts arrive); closing a thread clears its hash.
  useEffect(() => {
    setPosts([]);
    setCursor(0);
    setFeedError(null);
    setLastSyncedAt(null);
    let threadId: string | null = null;
    try {
      threadId = parseThreadHash(window.location.hash);
    } catch {
      threadId = null;
    }
    setOpenThreadId(threadId);
    setFetchingIds([]);
    setUnavailableIds([]);
    gapAttemptsRef.current = {};
    setLoadingOlder(false);
  }, [service]);

  // Opening a portal pulls recent posts immediately — even before an
  // identity exists, since reading the feed needs no key. This is what
  // makes a freshly opened community feel alive.
  useEffect(() => {
    if (!service) return;
    void refreshFeed();
  }, [service, refreshFeed]);

  // Poll the feed on a chained timeout (never overlapping): if a slow
  // mixnet outlasts the interval, the tick is skipped instead of piling up
  // another request. Reading needs no identity, so this runs for everyone.
  useEffect(() => {
    if (!service) return;
    let cancelled = false;
    let timer = 0;
    let inFlight = false;
    const tick = async () => {
      if (cancelled) return;
      if (!inFlight) {
        inFlight = true;
        try {
          await refreshFeed();
        } finally {
          inFlight = false;
        }
      }
      if (!cancelled) timer = window.setTimeout(tick, 30_000);
    };
    timer = window.setTimeout(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [service, refreshFeed]);

  const onLookup = useCallback(
    async (author: string) => {
      if (!service) return;
      try {
        const res = await fetchNym(service, { method: 'GET', path: `/profile/${author}` });
        if (res.error) {
          append(`no profile for ${author.slice(0, 12)}…`);
          return;
        }
        const p = JSON.parse(new TextDecoder().decode(res.body)) as { name: string };
        setNames((prev) => ({ ...prev, [author]: p.name || author.slice(0, 12) }));
      } catch (err) {
        append(`lookup failed: ${String(err)}`);
      }
    },
    [service, append],
  );

  // Timeline shows top-level posts; replies live in their threads.
  const topLevelPosts = useMemo(() => posts.filter((p) => normalizeParent(p.in_reply_to) === null), [posts]);

  const shareThreadLink = useCallback(() => {
    if (!openThreadId) return;
    try {
      const url = `${window.location.origin}${window.location.pathname}${formatThreadHash(openThreadId)}`;
      void copyText(url).then((ok) =>
        append(ok ? 'thread link copied' : 'copy unavailable — copy the URL manually'),
      );
    } catch {
      append('thread link unavailable here');
    }
  }, [openThreadId, append]);

  return {
    posts,
    topLevelPosts,
    postsById,
    threadNodes,
    activeThread,
    activeThreadMissingIds,
    syncing,
    lastSyncedAt,
    feedError,
    nowTick,
    oldestSeq,
    loadingOlder,
    openThreadId,
    fetchingIds,
    unavailableIds,
    names,
    refreshFeed,
    loadOlder,
    showThread,
    closeThread,
    shareThreadLink,
    onLookup,
    standingOf,
  };
}
