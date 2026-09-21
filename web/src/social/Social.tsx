/**
 * nysiris community UI: identity, tabbed timeline / private messages /
 * about views, composer, profiles, sealed DMs.
 *
 * Talks to a nysiris-social provider exclusively through `fetchNym` (one shared
 * client, requests serialized — the SDK cannot correlate concurrent calls).
 * Polls the feed and the DM dead-drop on chained, non-overlapping timeouts;
 * DM dead-drop; the server keeps no follows, likes, or read receipts. The
 * About tab mirrors the provider's landing page (`DESCRIPTOR_HTML` in
 * `services/social/src/service.rs`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchNym } from '../mixnet/fetchNym';
import { payloadHashBytes, provePow } from '../mixnet/pow.mjs';
import { createReputation } from '../mixnet/reputation.mjs';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  BACKUP_MIN_PASSWORD_LENGTH,
  MAX_INVITE_VOUCHES,
  createIdentity,
  currentDay,
  exportIdentityBackup,
  importIdentity,
  importIdentityBackup,
  loadIdentity,
  postPowPayload,
  signInvite,
  signPost,
  signProfile,
  verifyPostSignature,
  type Identity,
} from './identity';
import { encodeInviteCompact } from '../mixnet/hiddenService.mjs';
import { MAX_DM_CIPHERTEXT_BYTES, openDm, packDmInner, sealDm, unpackDmInner } from './dm';
import type { DmRecord } from './conversations';
import {
  addDmRecord,
  groupConversations,
  loadDmCache,
  loadDmRead,
  markConversationRead,
  saveDmCache,
  saveDmRead,
} from './conversations';
import {
  SOCIAL_TAB_META,
  SOCIAL_TAB_ORDER,
  defaultSocialTabStorage,
  loadSocialTab,
  saveSocialTab,
  type SocialTab,
} from './tabs';
import {
  STANDING_META,
  cautionFor,
  resolveStanding,
  shouldCollapse,
  standingTitle,
  type Verdict,
} from './trust';
import {
  authorLabel,
  duplicatePetnames,
  loadPetnames,
  savePetnames,
  withPetname,
} from './petnames';
import { describeSync, mergeFeedPosts } from './sync';
import { copyText, shortenAddress } from '../ui/share';
import { QrScanButton } from '../ui/QrScanButton';
import {
  MAX_GAP_FETCH_ATTEMPTS,
  buildThread,
  clearGapAttempt,
  countDescendants,
  formatThreadHash,
  missingAncestors,
  normalizeParent,
  noteGapAttempt,
  parseThreadHash,
} from './threads';
import { ThreadView } from './ThreadView';

interface Post {
  seq: number;
  id: string;
  author: string;
  day: number;
  body: string;
  /** Parent post id (hex) for replies; null for top-level posts. */
  in_reply_to: string | null;
  sig: string;
}

interface FeedReply {
  posts: Post[];
  next: number;
}

function dayLabel(day: number): string {
  return new Date(day * 86_400 * 1000).toISOString().slice(0, 10);
}

export function Social({
  service,
  onServiceChange,
  trustMap,
  onVerdict,
}: {
  service: string;
  onServiceChange: (service: string) => void;
  /** Explicit Trust/Block verdicts, owned by App so invites can write them too. */
  trustMap: Record<string, Verdict>;
  onVerdict: (author: string, verdict: Verdict | null) => void;
}) {
  const [identity, setIdentity] = useState<Identity | null>(() => loadIdentity());
  const [importKey, setImportKey] = useState('');
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const cursorRef = useRef(0);
  cursorRef.current = cursor;

  // Profile editor.
  const [profileName, setProfileName] = useState('');
  const [profileBio, setProfileBio] = useState('');

  // DMs (received-at timestamps are local: the envelope carries none,
  // and the provider deletes each message on read).
  const [dmTo, setDmTo] = useState('');
  const [dmDraft, setDmDraft] = useState('');
  // Local DM history: the dead-drop deletes on read, so every decrypted
  // record is cached on this device and grouped into 1:1 conversations.
  const [dms, setDms] = useState<DmRecord[]>(() => loadDmCache(localStorage));
  const [dmRead, setDmRead] = useState<Record<string, number>>(() => loadDmRead(localStorage));
  const [activeDmPeer, setActiveDmPeer] = useState<string | null>(null);

  // Community tabs (persisted): Timeline and Private messages are the
  // everyday views; About holds the profile editor, the service
  // description, and the technical log.
  const [tab, setTab] = useState<SocialTab>(() => loadSocialTab(defaultSocialTabStorage()));

  const onSelectTab = useCallback((next: SocialTab) => {
    setTab(next);
    saveSocialTab(next, defaultSocialTabStorage());
  }, []);

  // Partial-replica sync status: opening a portal pulls recent posts, and
  // the line under the timeline always says how fresh they are.
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Local web-of-trust: explicit verdicts live in App (shared with the
  // invite banner); petnames stay here. Both stay on this device.
  const [petnameMap, setPetnameMap] = useState<Record<string, string>>(() => {
    try {
      return loadPetnames(localStorage);
    } catch {
      return {};
    }
  });
  const [namingAuthor, setNamingAuthor] = useState<string | null>(null);
  const [namingValue, setNamingValue] = useState('');
  // Posts collapsed by the spam gate, revealed per post id for this session.
  const [revealedBlocked, setRevealedBlocked] = useState<Record<string, boolean>>({});
  // Timeline scope: everyone, or only explicitly/observably trusted authors.
  const [trustedOnly, setTrustedOnly] = useState<boolean>(() => {
    try {
      return localStorage.getItem('fly.social.trustedOnly') === '1';
    } catch {
      return false;
    }
  });
  // Attach the explicit-trust list as signed vouches on the next invite copy.
  const [vouchOnCopy, setVouchOnCopy] = useState(false);
  // Encrypted file backup (password + restore file).
  const [backupPw, setBackupPw] = useState('');
  const [restorePw, setRestorePw] = useState('');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const restoreFileRef = useRef<HTMLInputElement | null>(null);

  // Identity sharing (copy + local QR) and secret-key export reveal.
  const [idCopied, setIdCopied] = useState(false);
  const [showIdQr, setShowIdQr] = useState(false);
  const [idQrUrl, setIdQrUrl] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);

  // Composer focus target for the empty-state "be the first" call to action.
  const composerRef = useRef<HTMLInputElement | null>(null);

  // Threaded replies: which post the composer answers, and which thread is
  // open. Assembly is purely local (`threads.ts`); the service only stores
  // the parent link.
  const [replyTo, setReplyTo] = useState<Post | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [fetchingIds, setFetchingIds] = useState<string[]>([]);
  const [unavailableIds, setUnavailableIds] = useState<string[]>([]);

  const postsById = useMemo(() => new Map(posts.map((p) => [p.id, p])), [posts]);

  /** Minimal thread shape adapted from feed posts for `threads.ts`. */
  const threadNodes = useMemo(
    () =>
      new Map(
        posts.map((p) => [
          p.id,
          { id: p.id, inReplyTo: normalizeParent(p.in_reply_to), seq: p.seq },
        ]),
      ),
    [posts],
  );

  /** Authors sharing one petname: their labels get a hex suffix. */
  const dupeAuthors = useMemo(() => {
    const dupes = duplicatePetnames(petnameMap);
    return new Set(Object.values(dupes).flat());
  }, [petnameMap]);

  /** Start a reply: attach the parent and focus the composer. */
  const startReply = useCallback((post: Post) => {
    setReplyTo(post);
    onSelectTab('timeline');
    // Focus after the tab switch paints.
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [onSelectTab]);

  const savePetname = useCallback((author: string, name: string | null) => {
    setPetnameMap((prev) => {
      const next = withPetname(prev, author, name);
      try {
        savePetnames(next, localStorage);
      } catch {
        // Private mode: petnames just don't persist.
      }
      return next;
    });
    setNamingAuthor(null);
    setNamingValue('');
  }, []);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-19), `${new Date().toLocaleTimeString()}  ${line}`]);
  }, []);

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

  /**
   * Verify one feed item's signature before it renders: forged posts never
   * show, and the observation feeds local reputation (first-hand only). The
   * parent id is part of the signed bytes for replies.
   */
  const checkPost = useCallback((p: Post): boolean => {
    const parent = normalizeParent(p.in_reply_to);
    const ok = verifyPostSignature(
      p.author,
      p.day,
      new TextEncoder().encode(p.body),
      p.sig,
      parent,
    );
    recordRep(p.author, ok ? 'valid' : 'invalidSignature');
    if (!ok) append(`forged post dropped (seq ${p.seq})`);
    return ok;
  }, [append, recordRep]);

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

  // Required PoW difficulty per service, from its descriptor (cached).
  const powBitsCache = useRef(new Map<string, number>());

  /** Prove work if the service requires it; null when not required. */
  const powFor = useCallback(
    async (serviceAddr: string, keyHex: string, payload: Uint8Array) => {
      let bits = powBitsCache.current.get(serviceAddr);
      if (bits === undefined) {
        try {
          const res = await fetchNym(serviceAddr, { method: 'GET', path: '/' });
          const desc = JSON.parse(new TextDecoder().decode(res.body)) as { pow_bits?: unknown };
          bits = typeof desc.pow_bits === 'number' ? desc.pow_bits : 0;
        } catch {
          bits = 0;
        }
        powBitsCache.current.set(serviceAddr, bits);
      }
      if (!bits) return null;
      const hash = await payloadHashBytes(payload);
      return provePow(hexToBytes(keyHex), hash, bits, {});
    },
    [],
  );

  const authed = useCallback(async <T,>(fn: (id: Identity) => Promise<T>): Promise<T | null> => {
    const id = identity ?? createIdentity();
    setIdentity(id);
    return fn(id);
  }, [identity]);

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
  const oldestSeq = useMemo(
    () => posts.reduce((min, p) => Math.min(min, p.seq), Number.POSITIVE_INFINITY),
    [posts],
  );
  const [loadingOlder, setLoadingOlder] = useState(false);

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
    setDms([]);
    setFeedError(null);
    setLastSyncedAt(null);
    setReplyTo(null);
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

  // Local QR for your public ID: generated on this device, never uploaded.
  useEffect(() => {
    if (!showIdQr || !identity) return;
    let cancelled = false;
    setIdQrUrl(null);
    import('qrcode')
      .then((m) => m.toDataURL(identity.pubHex, { margin: 1, width: 220 }))
      .then(
        (url) => {
          if (!cancelled) setIdQrUrl(url);
        },
        () => {
          if (!cancelled) setIdQrUrl(null);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [showIdQr, identity]);

  // Encrypted file backup: password-encrypted copy of the secret key for
  // moving an ID without pasting raw hex. The hex export stays as fallback.
  const onExportBackup = useCallback(async () => {
    if (!identity) return;
    if (backupPw.length < BACKUP_MIN_PASSWORD_LENGTH) {
      append(`backup password must be at least ${BACKUP_MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    setBusy(true);
    try {
      const json = await exportIdentityBackup(identity.privHex, backupPw);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'fly-id-backup.json';
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      setBackupPw('');
      append('backup downloaded — store it away from the password');
    } catch (err) {
      append(`backup failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [identity, backupPw, append]);

  const onRestoreBackup = useCallback(async () => {
    if (!restoreFile) {
      append('pick a backup file first');
      return;
    }
    if (!restorePw) {
      append('enter the backup password');
      return;
    }
    setBusy(true);
    try {
      const json = await restoreFile.text();
      setIdentity(await importIdentityBackup(json, restorePw));
      setRestorePw('');
      setRestoreFile(null);
      if (restoreFileRef.current) restoreFileRef.current.value = '';
      append('identity restored from backup');
    } catch (err) {
      append(`restore failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [restoreFile, restorePw, append]);

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

  // Poll the DM dead-drop (needs an identity to open anything addressed to
  // you). Destructive read server-side: fetched messages are gone from the
  // provider, so every decrypted record is cached locally the moment it
  // arrives — the cache is the history.
  const pollDms = useCallback(async () => {
    if (!service || !identity) return;
    try {
      const res = await fetchNym(service, {
        method: 'GET',
        path: `/dm?for=${identity.pubHex}`,
      });
      if (res.error) return;
      const body = JSON.parse(new TextDecoder().decode(res.body)) as {
        dms: { epub: string; nonce: string; ciphertext: string }[];
      };
      const fresh: DmRecord[] = [];
      for (const dm of body.dms) {
        let plain: Uint8Array;
        try {
          plain = openDm(identity.privHex, {
            epubHex: dm.epub,
            nonceHex: dm.nonce,
            ciphertextB64: dm.ciphertext,
          });
        } catch {
          append('DM undecryptable (not for this key or corrupted)');
          continue;
        }
        const at = Date.now();
        try {
          const inner = unpackDmInner(new TextDecoder().decode(plain));
          fresh.push({
            peer: inner.from,
            incoming: true,
            text: new TextDecoder().decode(inner.body),
            at,
            ts: inner.ts,
            msgId: inner.msgId,
          });
        } catch {
          // Legacy sender (pre-envelope): no attribution possible.
          fresh.push({
            peer: 'unknown',
            incoming: true,
            text: new TextDecoder().decode(plain),
            at,
            ts: at,
            msgId: `legacy-${at}-${Math.random().toString(36).slice(2)}`,
          });
        }
      }
      if (fresh.length > 0) {
        setDms((prev) => {
          let next = prev;
          for (const r of fresh) next = addDmRecord(next, r);
          if (next !== prev) saveDmCache(next, localStorage);
          return next;
        });
        append(fresh.length === 1 ? 'DM received and decrypted' : `${fresh.length} DMs received and decrypted`);
      }
    } catch (err) {
      append(`dm poll failed: ${String(err)}`);
    }
  }, [service, identity, append]);

  // Same chained, non-overlapping pattern as the feed poll.
  useEffect(() => {
    if (!service || !identity) return;
    let cancelled = false;
    let timer = 0;
    let inFlight = false;
    const tick = async () => {
      if (cancelled) return;
      if (!inFlight) {
        inFlight = true;
        try {
          await pollDms();
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
  }, [service, identity, pollDms]);

  const onPost = useCallback(async () => {
    if (!service || !draft.trim()) return;
    setBusy(true);
    try {
      await authed(async (id) => {
        const body = new TextEncoder().encode(draft.trim().slice(0, 1400));
        const day = currentDay();
        // Replying keeps the parent's id stable for the whole send: capture
        // it up front so a thread switch mid-send can't retarget the post.
        const parent = replyTo ? normalizeParent(replyTo.id) : null;
        const sig = signPost(id.privHex, id.pubHex, day, body, parent);
        const pow = await powFor(service, id.pubHex, postPowPayload(body, parent));
        const res = await fetchNym(service, {
          method: 'POST',
          path: '/post',
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(
            JSON.stringify({
              author: id.pubHex,
              day,
              body: new TextDecoder().decode(body),
              ...(parent ? { in_reply_to: parent } : {}),
              sig,
              ...(pow ? { pow } : {}),
            }),
          ),
        });
        if (res.error) append(`post rejected: ${res.error}`);
        else {
          append(parent ? 'reply posted' : 'posted');
          setDraft('');
          setReplyTo(null);
          // The new post carries a higher seq than the cursor, so the next
          // forward poll picks it up — no need to re-walk from genesis.
          await refreshFeed();
        }
      });
    } catch (err) {
      append(`post failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [service, draft, replyTo, authed, refreshFeed, append, powFor]);

  const onSaveProfile = useCallback(async () => {
    if (!service) return;
    setBusy(true);
    try {
      await authed(async (id) => {
        const sig = signProfile(id.privHex, id.pubHex, profileName, profileBio);
        const preimage = new TextEncoder().encode(`${profileName}\0${profileBio}`);
        const pow = await powFor(service, id.pubHex, preimage);
        const res = await fetchNym(service, {
          method: 'POST',
          path: '/profile',
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(
            JSON.stringify({
              author: id.pubHex,
              name: profileName,
              bio: profileBio,
              day: currentDay(),
              sig,
              ...(pow ? { pow } : {}),
            }),
          ),
        });
        append(res.error ? `profile rejected: ${res.error}` : 'profile saved');
      });
    } catch (err) {
      append(`profile failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [service, profileName, profileBio, authed, append, powFor]);

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

  const onSendDm = useCallback(async () => {
    if (!service || !dmTo || !dmDraft) return;
    const recipient = dmTo.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(recipient)) {
      append('recipient must be a 64-hex ID');
      return;
    }
    setBusy(true);
    try {
      await authed(async (id) => {
        // Signed inside the sealed box: the recipient can attribute the
        // message, the provider cannot.
        const packed = packDmInner(id.privHex, new TextEncoder().encode(dmDraft));
        const sealed = sealDm(recipient, new TextEncoder().encode(packed.json));
        const ctBytes = Uint8Array.from(atob(sealed.ciphertextB64), (c) => c.charCodeAt(0));
        if (ctBytes.length > MAX_DM_CIPHERTEXT_BYTES) {
          append(`dm too large sealed (${ctBytes.length}B > ${MAX_DM_CIPHERTEXT_BYTES}B); shorten it`);
          return;
        }
        const pow = await powFor(service, recipient, ctBytes);
        const res = await fetchNym(service, {
          method: 'POST',
          path: '/dm',
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(
            JSON.stringify({
              to: recipient,
              epub: sealed.epubHex,
              nonce: sealed.nonceHex,
              ciphertext: sealed.ciphertextB64,
              ...(pow ? { pow } : {}),
            }),
          ),
        });
        if (res.error) append(`dm rejected: ${res.error}`);
        else {
          append('DM sent (sealed)');
          setDmDraft('');
          const at = Date.now();
          setDms((prev) => {
            const next = addDmRecord(prev, {
              peer: recipient,
              incoming: false,
              text: dmDraft,
              at,
              ts: at,
              msgId: packed.msgId,
            });
            saveDmCache(next, localStorage);
            return next;
          });
          setActiveDmPeer(recipient);
        }
      });
    } catch (err) {
      append(`dm failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [service, dmTo, dmDraft, append, powFor, authed]);

  // Shared post body for the timeline list and the thread view: trust dot,
  // display name (petname > profile > short hex), inline naming, and
  // Trust/Block verdicts. Blocked authors collapse (tap to reveal), watch
  // authors get a caution line. Action rows (View thread / Reply) are added
  // by each caller around it.
  const renderPostBody = useCallback(
    (p: Post) => {
      const observed = repRef.current?.standing(p.author, currentDay()) ?? 'unknown';
      const explicit = trustMap[p.author.toLowerCase()] ?? null;
      const standing = resolveStanding(explicit, observed);
      const meta = STANDING_META[standing];
      const petname = petnameMap[p.author.toLowerCase()] ?? null;
      const profileName = names[p.author] ?? null;
      const isNaming = namingAuthor === p.author;
      if (shouldCollapse(standing) && !revealedBlocked[p.id]) {
        return (
          <div>
            <span
              title={standingTitle(standing, explicit !== null)}
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: meta.color,
                marginRight: 6,
              }}
            />
            <strong>{authorLabel(p.author, petname, profileName)}</strong>{' '}
            <span style={{ color: '#888' }}>{dayLabel(p.day)}</span>{' '}
            <span style={{ fontSize: 12, color: '#888' }}>Blocked author — post hidden.</span>{' '}
            <button
              className="fly-btn"
              style={{ fontSize: 11 }}
              onClick={() => setRevealedBlocked((prev) => ({ ...prev, [p.id]: true }))}
            >
              Show anyway
            </button>
          </div>
        );
      }
      const caution = cautionFor(standing);
      return (
        <>
          <span
            title={standingTitle(standing, explicit !== null)}
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: meta.color,
              marginRight: 6,
            }}
          />
          <strong>{authorLabel(p.author, petname, profileName)}</strong>
          {dupeAuthors.has(p.author.toLowerCase()) && (
            <span
              style={{ fontSize: 11, color: '#888' }}
              title="Same name as another author — the hex tells them apart"
            >
              {' '}·{p.author.slice(0, 8)}…
            </span>
          )}{' '}
          <span style={{ color: '#888' }}>{dayLabel(p.day)}</span>{' '}
          {!profileName && !petname && !isNaming && (
            <>
              <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => onLookup(p.author)}>
                who?
              </button>{' '}
            </>
          )}
          {!isNaming ? (
            <button
              className="fly-btn"
              style={{ fontSize: 11 }}
              title="Give them a name only you see"
              onClick={() => {
                setNamingAuthor(p.author);
                setNamingValue(petname ?? '');
              }}
            >
              Name
            </button>
          ) : (
            <span>
              <input
                className="fly-input"
                style={{ width: 140, fontSize: 12 }}
                placeholder="name only you see"
                value={namingValue}
                onChange={(e) => setNamingValue(e.target.value)}
                maxLength={40}
                spellCheck={false}
                aria-label="Petname for this author"
              />{' '}
              <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => savePetname(p.author, namingValue)}>
                Save
              </button>{' '}
              {petname && (
                <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => savePetname(p.author, null)}>
                  Clear
                </button>
              )}{' '}
              <button
                className="fly-btn"
                style={{ fontSize: 11 }}
                onClick={() => {
                  setNamingAuthor(null);
                  setNamingValue('');
                }}
              >
                Cancel
              </button>
            </span>
          )}{' '}
          {explicit === null ? (
            <>
              <button className="fly-btn" style={{ fontSize: 11 }} title="Always show them as trusted" onClick={() => onVerdict(p.author, 'trusted')}>
                Trust
              </button>{' '}
              <button className="fly-btn" style={{ fontSize: 11 }} title="Always show them as blocked" onClick={() => onVerdict(p.author, 'blocked')}>
                Block
              </button>
            </>
          ) : (
            <button
              className="fly-btn"
              style={{ fontSize: 11 }}
              title="Back to first-hand observations"
              onClick={() => onVerdict(p.author, null)}
            >
              Undo {explicit === 'trusted' ? 'trust' : 'block'}
            </button>
          )}
          <div style={{ wordBreak: 'break-word' }}>{p.body}</div>
          {caution && (
            <div style={{ fontSize: 11, color: '#b26b00', marginTop: 4 }} role="note">
              ⚠ {caution}.
            </div>
          )}
        </>
      );
    },
    [
      trustMap,
      petnameMap,
      names,
      namingAuthor,
      namingValue,
      dupeAuthors,
      revealedBlocked,
      onLookup,
      savePetname,
      onVerdict,
    ],
  );

  // Timeline shows top-level posts; replies live in their threads.
  const topLevelPosts = useMemo(
    () => posts.filter((p) => normalizeParent(p.in_reply_to) === null),
    [posts],
  );

  return (
    <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Community</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          style={{ flex: 1 }}
          className="fly-input"
          placeholder="Private community — set automatically when you open a private link"
          value={service}
          onChange={(e) => onServiceChange(e.target.value)}
          spellCheck={false}
        />
        <button onClick={() => { void refreshFeed(); }} disabled={busy || !service} className='fly-btn fly-btn-primary'>
          Refresh
        </button>
      </div>

      <div style={{ fontSize: 13, marginBottom: 8 }}>
        {!identity ? (
          <div className="fly-row" style={{ alignItems: 'center' }}>
            <span style={{ wordBreak: 'break-word' }}>
              You need a private ID to post or receive messages — one tap creates it on this device.
            </span>
            <button
              className="fly-btn fly-btn-primary"
              onClick={() => {
                const id = createIdentity();
                setIdentity(id);
                append('new identity generated');
              }}
            >
              Create my private ID
            </button>
          </div>
        ) : (
          <span style={{ wordBreak: 'break-all' }}>
            Your private ID: <code>{identity.pubHex.slice(0, 12)}…</code>{' '}
            <button
              style={{ fontSize: 11 }}
              className='fly-btn fly-btn-primary'
              onClick={() => {
                void copyText(identity.pubHex).then((ok) => {
                  setIdCopied(ok);
                  append(ok ? 'ID copied' : 'copy unavailable — see technical details');
                  if (!ok) setShowSecret(false);
                });
              }}
            >
              {idCopied ? 'Copied' : 'Copy my ID'}
            </button>{' '}
            <button style={{ fontSize: 11 }} onClick={() => setShowIdQr((v) => !v)} aria-expanded={showIdQr} className='fly-btn fly-btn-primary'>
              {showIdQr ? 'Hide QR' : 'Show QR'}
            </button>{' '}
            <details style={{ display: 'inline' }}>
              <summary style={{ display: 'inline', cursor: 'pointer', fontSize: 11 }}>
                Show technical details
              </summary>{' '}
              <code style={{ fontSize: 11 }}>{identity.pubHex}</code>
            </details>{' '}
            <button
              style={{ fontSize: 11 }}
              className='fly-btn fly-btn-primary'
              onClick={() => {
                const id = createIdentity();
                setIdentity(id);
                setIdCopied(false);
                setShowIdQr(false);
                append('new identity generated');
              }}
            >
              New ID
            </button>{' '}
            {(() => {
              const trustedVoices = Object.entries(trustMap)
                .filter(([, v]) => v === 'trusted')
                .map(([author]) => author)
                .slice(0, MAX_INVITE_VOUCHES);
              return (
                <>
                  {trustedVoices.length > 0 && (
                    <label style={{ fontSize: 11, marginRight: 8 }} title="Sign your explicit-trust list into the invite so the recipient sees who you vouch for">
                      <input
                        type="checkbox"
                        checked={vouchOnCopy}
                        onChange={(e) => setVouchOnCopy(e.target.checked)}
                      />{' '}
                      Vouch for {trustedVoices.length} trusted
                    </label>
                  )}
            <button
              style={{ fontSize: 11 }}
              className='fly-btn fly-btn-primary'
              title="Sign an invite link for this community and copy it"
              onClick={() => {
                if (!service) {
                  append('open a private link first');
                  return;
                }
                const id = identity ?? createIdentity();
                setIdentity(id);
                try {
                  const invite = signInvite(
                    id.privHex,
                    service,
                    `Join me here`,
                    vouchOnCopy ? trustedVoices : [],
                  );
                  const link = `${service}#invite=${encodeInviteCompact(invite)}`;
                  void copyText(link).then((ok) =>
                    append(
                      ok
                        ? `invite link copied${invite.vouches ? ` (${invite.vouches.length} vouches)` : ''}`
                        : `invite link (copy manually): ${link.slice(0, 80)}…`,
                    ),
                  );
                } catch (err) {
                  append(`invite failed: ${String(err)}`);
                }
              }}
              disabled={busy || !service}
            >
              Copy invite link
            </button>
                </>
              );
            })()}
          </span>
        )}
        {identity && !profileName.trim() && (
          <p style={{ fontSize: 11, color: '#888', margin: '4px 0 0' }}>
            Tip: set your display name under About → Your profile so others recognize you.
          </p>
        )}
        {identity && showIdQr && (
          <div style={{ marginTop: 8 }}>
            {idQrUrl ? (
              <img className="fly-qr" src={idQrUrl} alt="QR code for your private ID" width={220} height={220} />
            ) : (
              <p className="fly-muted" role="status">Making your QR code…</p>
            )}
            <p className="fly-muted">Others scan this to message you. The code is made on this device.</p>
          </div>
        )}
        <details style={{ marginTop: 4 }}>
          <summary style={{ fontSize: 11, cursor: 'pointer' }}>Move my ID to another device</summary>
          <p style={{ fontSize: 11, color: '#888', margin: '4px 0' }}>
            {identity
              ? 'Step 1 — on this device, reveal and copy your secret key. Step 2 — on the other device, paste it below. Anyone with this key is you: never share it with another person.'
              : 'Paste the secret key from your other device to bring your ID here.'}
          </p>
          {identity && (
            <div style={{ marginBottom: 4 }}>
              {!showSecret ? (
                <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => { setShowSecret(true); setSecretCopied(false); }}>
                  Reveal secret key
                </button>
              ) : (
                <span style={{ wordBreak: 'break-all' }}>
                  <code style={{ fontSize: 11 }}>{identity.privHex}</code>{' '}
                  <button
                    style={{ fontSize: 11 }}
                    className='fly-btn fly-btn-primary'
                    onClick={() => {
                      void copyText(identity.privHex).then((ok) => {
                        setSecretCopied(ok);
                        append(ok ? 'secret key copied' : 'copy unavailable — select it manually');
                      });
                    }}
                  >
                    {secretCopied ? 'Copied' : 'Copy secret'}
                  </button>{' '}
                  <button style={{ fontSize: 11 }} onClick={() => setShowSecret(false)} className='fly-btn fly-btn-primary'>
                    Hide
                  </button>
                </span>
              )}
            </div>
          )}
          <input
            style={{ marginLeft: 8, width: 200 }}
            placeholder="paste secret key"
            className='fly-input'
            value={importKey}
            onChange={(e) => setImportKey(e.target.value)}
            spellCheck={false}
          />
          <button
            style={{ fontSize: 11 }}
            className='fly-btn fly-btn-primary'
            onClick={() => {
              try {
                setIdentity(importIdentity(importKey));
                setImportKey('');
                append('identity imported');
              } catch (err) {
                append(`import failed: ${String(err)}`);
              }
            }}
          >
            Import
          </button>
        </details>
        <details style={{ marginTop: 4 }}>
          <summary style={{ fontSize: 11, cursor: 'pointer' }}>Back up / restore (encrypted file)</summary>
          <p style={{ fontSize: 11, color: '#888', margin: '4px 0' }}>
            Password-encrypted copy of your secret key — easier than raw hex on a new
            device. Anyone with this file <em>and</em> the password is you: store
            them separately.
          </p>
          {identity && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 4, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="password"
                style={{ width: 200 }}
                className="fly-input"
                placeholder={`backup password (${BACKUP_MIN_PASSWORD_LENGTH}+ chars)`}
                value={backupPw}
                onChange={(e) => setBackupPw(e.target.value)}
                autoComplete="new-password"
                aria-label="Backup password"
              />
              <button
                style={{ fontSize: 11 }}
                className="fly-btn fly-btn-primary"
                onClick={() => void onExportBackup()}
                disabled={busy || backupPw.length < BACKUP_MIN_PASSWORD_LENGTH}
              >
                Download backup
              </button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              ref={restoreFileRef}
              type="file"
              accept=".json,application/json"
              style={{ fontSize: 11 }}
              aria-label="Backup file"
              onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)}
            />
            <input
              type="password"
              style={{ width: 200 }}
              className="fly-input"
              placeholder="backup password"
              value={restorePw}
              onChange={(e) => setRestorePw(e.target.value)}
              autoComplete="current-password"
              aria-label="Restore password"
            />
            <button
              style={{ fontSize: 11 }}
              className="fly-btn fly-btn-primary"
              onClick={() => void onRestoreBackup()}
              disabled={busy || !restoreFile || !restorePw}
            >
              Restore
            </button>
          </div>
        </details>
      </div>

      <div role="tablist" aria-label="Community sections" className="fly-tabbar">
        {SOCIAL_TAB_ORDER.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            title={SOCIAL_TAB_META[id].blurb}
            onClick={() => onSelectTab(id)}
            className="fly-tab"
          >
            {SOCIAL_TAB_META[id].title}
          </button>
        ))}
      </div>

      {tab === 'timeline' && (
      <div role="tabpanel" aria-label="Timeline">
      {replyTo && (
        <div
          style={{
            border: '1px solid #ccc',
            borderRadius: 8,
            padding: '6px 10px',
            marginBottom: 8,
            fontSize: 12,
            background: 'var(--fly-bg, #f7f5f2)',
          }}
        >
          Replying to{' '}
          <strong>
            {authorLabel(replyTo.author, petnameMap[replyTo.author.toLowerCase()] ?? null, names[replyTo.author] ?? null)}
          </strong>
          : “{replyTo.body.slice(0, 80)}{replyTo.body.length > 80 ? '…' : ''}”{' '}
          <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => setReplyTo(null)} aria-label="Cancel reply">
            ✕
          </button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          ref={composerRef}
          style={{ flex: 1 }}
          placeholder={replyTo ? 'Write a reply…' : 'Share something (max 1400 characters)'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={1400}
          className='fly-input'
        />
        <button onClick={onPost} disabled={busy || !service || !draft.trim()} className='fly-btn fly-btn-secondary'>
          {replyTo ? 'Reply' : 'Post'}
        </button>
      </div>

      <h3 style={{ fontSize: 15 }}>Timeline</h3>
      <p style={{ fontSize: 11, color: '#888' }}>
        Global chronological timeline — every post is checked before it
        appears, so fakes never show.
      </p>
      <div style={{ margin: '4px 0 8px' }}>
        <button
          className="fly-btn"
          style={{ fontSize: 12 }}
          aria-pressed={trustedOnly}
          title="Hide posts from authors you have not trusted"
          onClick={() => {
            setTrustedOnly((prev) => {
              const next = !prev;
              try {
                localStorage.setItem('fly.social.trustedOnly', next ? '1' : '0');
              } catch {
                // Private mode: scope just doesn't persist.
              }
              return next;
            });
          }}
        >
          {trustedOnly ? 'Showing trusted only ✓' : 'Show: everyone'}
        </button>
      </div>
      <p style={{ fontSize: 11, color: '#888', marginTop: -4 }} aria-label="Trust legend">
        {(Object.keys(STANDING_META) as (keyof typeof STANDING_META)[])
          .filter((s) => s !== 'unknown')
          .map((s) => (
            <span key={s} title={STANDING_META[s].blurb} style={{ marginRight: 10 }}>
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: STANDING_META[s].color,
                  marginRight: 4,
                }}
              />
              {STANDING_META[s].label}
            </span>
          ))}
        <span title="Your explicit call always wins over what was observed"> — your call wins</span>
      </p>
      {(() => {
        const sync = describeSync(nowTick, { syncing, lastSyncedAt, error: feedError });
        const tone = sync.tone === 'bad' ? '#b00020' : sync.tone === 'busy' ? '#b26b00' : '#888';
        return (
          <p style={{ fontSize: 11, color: tone }} role="status">
            {sync.text}{' '}
            {feedError && (
              <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => void refreshFeed()} disabled={busy || !service}>
                Retry
              </button>
            )}
          </p>
        );
      })()}
      {Number.isFinite(oldestSeq) && oldestSeq > 1 && (
        <div style={{ marginBottom: 8 }}>
          <button
            className="fly-btn"
            style={{ fontSize: 11 }}
            onClick={() => void loadOlder()}
            disabled={loadingOlder || busy || !service}
          >
            {loadingOlder ? 'Loading older…' : 'Load older posts'}
          </button>
        </div>
      )}
      {posts.length === 0 && !syncing && !feedError ? (
        <div
          style={{
            border: '1px dashed #aaa',
            borderRadius: 8,
            padding: '20px 16px',
            textAlign: 'center',
            fontSize: 13,
            color: '#666',
          }}
        >
          <p style={{ margin: '0 0 4px', fontSize: 15, color: 'inherit' }}>
            <strong>Nothing here yet</strong>
          </p>
          <p style={{ margin: '0 0 12px' }}>
            {service
              ? 'This community is quiet. Say the first word — it stays signed by your ID.'
              : 'Open a private link above to join a community, then come back here.'}
          </p>
          {service && (
            <button
              className='fly-btn fly-btn-primary'
              onClick={() => {
                onSelectTab('timeline');
                composerRef.current?.focus();
              }}
            >
              Be the first to post
            </button>
          )}
        </div>
      ) : (
      openThreadId && activeThread ? (
        <ThreadView
          rootId={openThreadId}
          root={activeThread.root}
          replies={activeThread.replies}
          missingIds={(() => {
            const ids = new Set<string>(activeThread.missing);
            for (const reply of activeThread.replies) {
              for (const mid of missingAncestors([reply.id], threadNodes)) ids.add(mid);
            }
            return [...ids];
          })()}
          loadingIds={fetchingIds}
          unavailableIds={unavailableIds}
          onBack={() => closeThread()}
          onShareLink={() => {
            try {
              const url = `${window.location.origin}${window.location.pathname}${formatThreadHash(openThreadId)}`;
              void copyText(url).then((ok) =>
                append(ok ? 'thread link copied' : 'copy unavailable — copy the URL manually'),
              );
            } catch {
              append('thread link unavailable here');
            }
          }}
          onReply={(postId) => {
            const target = postsById.get(postId);
            if (target) startReply(target);
          }}
          renderPost={(node) => {
            const full = postsById.get(node.id);
            return full ? renderPostBody(full) : null;
          }}
        />
      ) : (
      <ul style={{ fontSize: 13, listStyle: 'none', padding: 0 }}>
        {(trustedOnly
          ? topLevelPosts.filter(
              (p) =>
                resolveStanding(
                  trustMap[p.author.toLowerCase()] ?? null,
                  repRef.current?.standing(p.author, currentDay()) ?? 'unknown',
                ) === 'trusted',
            )
          : topLevelPosts
        ).map((p) => {
          const replyCount = countDescendants(p.id, threadNodes);
          return (
            <li key={p.seq} style={{ borderTop: '1px solid #eee', padding: '6px 0' }}>
              <span
                role="button"
                tabIndex={0}
                onClick={() => showThread(p.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') showThread(p.id);
                }}
                title="Open thread"
                style={{ cursor: 'pointer', display: 'block' }}
              >
                {renderPostBody(p)}
              </span>
              <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
                {replyCount > 0 && (
                  <button
                    className="fly-btn"
                    style={{ fontSize: 11 }}
                    onClick={() => showThread(p.id)}
                    aria-label={`View thread with ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
                  >
                    {replyCount} {replyCount === 1 ? 'reply' : 'replies'} · View thread
                  </button>
                )}
                <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => startReply(p)}>
                  Reply
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      )
      )}
      </div>
      )}

      {tab === 'messages' && (() => {
        const convos = groupConversations(dms, dmRead);
        const totalUnread = convos.reduce((n, c) => n + c.unread, 0);
        const activeConvo = convos.find((c) => c.peer === activeDmPeer) ?? null;
        const peerLabel = (peer: string) =>
          peer === 'unknown'
            ? 'Unknown sender (legacy)'
            : authorLabel(peer, petnameMap[peer.toLowerCase()] ?? null, names[peer] ?? null);
        const openConvo = (peer: string) => {
          setActiveDmPeer(peer);
          if (peer !== 'unknown') setDmTo(peer);
          setDmRead((prev) => {
            const next = markConversationRead(prev, peer);
            if (next !== prev) saveDmRead(next, localStorage);
            return next;
          });
        };
        return (
      <div role="tabpanel" aria-label="Private messages">
      <h3 style={{ fontSize: 15, marginTop: 0 }}>
        Private messages{totalUnread > 0 && <span style={{ color: '#888' }}> ({totalUnread} unread)</span>}
      </h3>
      <div
        style={{
          border: '1px solid #0a7a4a',
          borderRadius: 8,
          padding: '8px 12px',
          marginBottom: 8,
          fontSize: 12,
        }}
      >
        <strong>Self-destruct on read.</strong> Each message is sealed so only
        you can open it — and the moment you pick it up, it is deleted from
        the community. Nobody can replay it, not even the host.
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input className="fly-input" style={{ flex: 1 }} placeholder="Their ID" value={dmTo} onChange={(e) => setDmTo(e.target.value)} spellCheck={false} />
        <QrScanButton
          label="Scan ID"
          onScanText={(text) => {
            const id = text.trim().toLowerCase();
            if (/^[0-9a-f]{64}$/.test(id)) setDmTo(id);
            else append('that QR code is not an ID (64 hex characters)');
          }}
          onScanError={(message) => append(`qr scan: ${message}`)}
        />
        <input className="fly-input" style={{ flex: 2 }} placeholder="Secret message" value={dmDraft} onChange={(e) => setDmDraft(e.target.value)} />
        <button className="fly-btn fly-btn-primary" onClick={onSendDm} disabled={busy || !service || !dmTo || !dmDraft}>
          Send privately
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <button
          className="fly-btn"
          style={{ fontSize: 12 }}
          onClick={() => {
            void pollDms();
          }}
          disabled={busy || !service || !identity}
        >
          Check for new messages
        </button>
        <span style={{ fontSize: 11, color: '#888' }}>New arrivals appear automatically.</span>
      </div>
      {convos.length > 0 && (
        <>
          <h3 style={{ fontSize: 15 }}>Conversations</h3>
          <ul className="fly-conv-list">
            {convos.map((c) => {
              const last = c.messages[c.messages.length - 1];
              return (
                <li key={c.peer}>
                  <button aria-current={activeDmPeer === c.peer} onClick={() => openConvo(c.peer)}>
                    <strong>{peerLabel(c.peer)}</strong>
                    {c.unread > 0 && <span> ({c.unread} new)</span>}{' '}
                    <span className="fly-muted">
                      {last ? last.text.slice(0, 60) : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {activeConvo ? (
        <>
          <h3 style={{ fontSize: 15 }}>Chat with {peerLabel(activeConvo.peer)}</h3>
          <ul style={{ fontSize: 13, listStyle: 'none', padding: 0 }}>
            {activeConvo.messages.map((m) => (
              <li key={m.msgId} style={{ borderTop: '1px solid #eee', padding: '6px 0' }}>
                {m.incoming ? (
                  <span title="Only you can read this — it was deleted from the community when you picked it up">
                    🔒
                  </span>
                ) : (
                  <span title="Sent by you">✓ </span>
                )}{' '}
                <span style={{ wordBreak: 'break-word' }}>{m.text}</span>{' '}
                <span style={{ color: '#888', fontSize: 11 }}>
                  {new Date(m.ts).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p style={{ fontSize: 13, color: '#888' }}>
          {convos.length === 0
            ? 'Nothing here yet — received messages appear automatically.'
            : 'Pick a conversation above.'}
        </p>
      )}
      </div>
        );
      })()}

      {tab === 'about' && (
      <div role="tabpanel" aria-label="About this community">
      <h3 style={{ fontSize: 15, marginTop: 0 }}>About this community</h3>
      <p style={{ fontSize: 13 }}>
        Metadata-minimal microblog + encrypted DMs, reachable only over the
        private network.
      </p>
      <ul style={{ fontSize: 13 }}>
        <li><code>GET /feed?since=&lt;seq&gt;&amp;limit=&lt;n&gt;</code> — global chronological timeline</li>
        <li><code>POST /post</code> — signed micro-post (max 1400 bytes; optional <code>in_reply_to</code> parent id for replies)</li>
        <li><code>GET /post/&lt;id&gt;</code> — one post by id, for filling thread gaps</li>
        <li><code>GET /profile/&lt;pubkey&gt;</code> / <code>POST /profile</code> — self-asserted profiles</li>
        <li><code>POST /dm</code> / <code>GET /dm?for=&lt;pubkey&gt;</code> — sealed direct messages, self-destruct on read</li>
      </ul>
      <p style={{ fontSize: 13 }}>
        No accounts, no follows, no likes, no read receipts. Your public key
        is your name.
      </p>

      <h3 style={{ fontSize: 15 }}>Your profile</h3>
      <p style={{ fontSize: 11, color: '#888' }}>
        Self-asserted: the name and bio you set here are signed by your ID.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input className="fly-input" style={{ flex: 1 }} placeholder="display name" value={profileName} onChange={(e) => setProfileName(e.target.value)} maxLength={40} />
        <input className="fly-input" style={{ flex: 2 }} placeholder="bio" value={profileBio} onChange={(e) => setProfileBio(e.target.value)} maxLength={280} />
        <button className="fly-btn fly-btn-primary" onClick={onSaveProfile} disabled={busy || !service}>
          Save profile
        </button>
      </div>

      <details style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 11, color: '#888', cursor: 'pointer' }}>
          Technical log
        </summary>
        <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', marginTop: 8, color: '#888' }}>{log.join('\n')}</pre>
      </details>
      <p style={{ fontSize: 11, color: '#888' }}>
        Your keys stay in this browser. Messages are sealed end-to-end; the
        community stores only scrambled text. Messages disappear after being
        read; the server keeps nothing else (no follows, likes, or receipts).
      </p>
      </div>
      )}
    </section>
  );
}
