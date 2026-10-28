import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import {
  ensureTunnel,
  reconnectTunnel,
  teardownTunnel,
  tunnelState,
  tunnelSpent,
  type TunnelStateView,
} from '../../../mixnet/tunnel';
import { exitStatus, mixnetFetch, proveTunnel, resetExitPolicy } from '../../../mixnet/fetch';
import { NymAddressClient, type IncomingMessage } from '../../../mixnet/messaging';
import { fetchNym, fetchNymFull, stopFetchNymClient } from '../../../mixnet/fetchNym';
import {
  addBlankTab,
  applyPage,
  canGoBack,
  canGoForward,
  closeBrowserTab,
  failPage,
  historyEntry,
  loadBrowserTabs,
  navigateTab,
  newTabId,
  pageKindFor,
  saveBrowserTabs,
  settlePage,
  stopPage,
  tabTitle,
  type BrowserTab,
} from '../../../application/browser';
import { resolveNavigationInput, type NavigationTarget, type ParsedInvite } from '../../../application/navigation';
import { b64decode, b64encode } from '../../../lib/bytes';
import { isAbortError } from '../../../lib/abort';
import { prepareDocument, type ResourceKind, type ResourceResponse } from '../../../application/contentLoader';
import type { EmbeddedDocument } from '../../../application/embeddedDocuments';
import { DocumentCache } from '../../../application/documentCache';
import { CookieJar, loadCookieJar, saveCookieJar } from '../../../application/cookies';
import { CredentialStore, authScopeFor, isSupportedChallenge, parseAuthChallenge, type AuthChallenge } from '../../../application/auth';
import { clearnetFetch, type ClearnetResult } from '../../../application/clearnet';
import { decodeContentEncoding } from '../../../application/encoding';
import {
  conditionalRequestHeaders,
  filenameFromDisposition,
  headerValue,
  headersToRecord,
  parseContentLength,
  responseValidators,
  type HeaderRecord,
} from '../../../application/httpHeaders';
import { responseTotal } from '../../../application/ranges';
import {
  TransferError,
  transferRanges,
  type RangeFetcher,
} from '../../../application/downloadTransfer';
import { loadScrollPositions, rememberScroll } from '../../../application/scrollStore';
import { cycleMatch, findMatches, highlightSegments } from '../../../application/find';
import { clampZoom, loadZoom, nextZoom, saveZoom } from '../../../application/zoom';
import {
  PermissionRegistry,
  loadPermissions,
  permissionScopeFor,
  savePermissions,
  type PermissionDecision,
  type PermissionName,
} from '../../../application/permissions';
import { printDocument } from '../../../shared/print';
import { isOnline, serviceWorkerSupported, watchConnectivity } from '../../../pwa';
import { subscribeDeepLinks, takeInitialDeepLink } from '../../../adapters/driven/deepLink';
import { BrowserTools } from './BrowserTools';
import { PermissionsPanel } from './PermissionsPanel';
import { EmbeddedDocuments } from './EmbeddedDocuments';
import { MediaView } from './MediaView';
import { startMediaBridge } from '../../../adapters/driven/mediaBridge';
import {
  defaultMediaCache,
  downloadMediaToCache,
} from '../../../application/portalMediaCache';
import {
  isStreamableContentType,
  looksLikeStreamableUrl,
  mediaStreamingAvailable,
} from '../../../application/mediaSession';
import { clearFindHighlights, focusFindMatch, highlightFindMatches } from './findInDocument';
import {
  addDownload,
  clearDownloads,
  formatSize,
  loadDownloads,
  newDownloadId,
  removeDownload,
  saveDownloads,
  updateDownload,
  type DownloadRecord,
} from '../../../application/downloads';
import { BrowserChrome } from './BrowserChrome';
import { startForeground, stopForeground } from '../../../adapters/driven/foreground.mjs';
import { Social } from '../social/Social';
import { verifyInvite } from '../../../domain/identity';
import { loadTrust, saveTrust, withVerdict, defaultTrustStorage, type Verdict } from '../../../application/trustStore';
import { Panel } from '../shared/Panel';
import { Toolbar } from './Toolbar';
import { ContactsPanel, type PendingInvite } from './ContactsPanel';
import { PortalSync } from '../portal/PortalSync';
import { PortalWorkspace } from '../portal/PortalWorkspace';
import { DownloadManager } from '../portal/DownloadManager';
import { PdfView } from './PdfView';
import {
  addContact,
  defaultContactStorage,
  loadContacts,
  saveContacts,
  type Contact,
} from '../../../application/contacts';
import {
  addBookmark,
  defaultBookmarkStorage,
  isBookmarked,
  loadBookmarks,
  removeBookmark,
  saveBookmarks,
  type Bookmark,
} from '../../../application/bookmarks';
import { defaultStorage, loadOpenPanels, saveOpenPanels, type PanelId } from '../../../application/panels';
import { describeStatus } from '../../../mixnet/status';
import { AppNav } from './AppNav';
import { Onboarding } from './Onboarding';
import { FriendlyError } from '../shared/FriendlyError';
import { BookmarkIcon, StarIcon } from '../shared/icons';
import { QrScanButton } from '../shared/QrScanButton';
import { ShareCard } from '../shared/ShareCard';
import { RunPortal } from '../portal/RunPortal';
import {
  defaultViewStorage,
  loadActiveView,
  loadAdvancedVisible,
  loadOnboarded,
  saveActiveView,
  saveAdvancedVisible,
  saveOnboarded,
  type ViewId,
} from '../../../application/views';
import { friendlyError } from '../../../shared/friendlyErrors';
import {
  shortenAddress,
  threadKeyFor,
  threadLabel,
  buildInboxThreads,
  threadUnread,
  isContactThread,
  contactAddressOf,
} from '../../../shared/share';
import { ContextPanel, Roster, TopBar, type RosterPortal } from './DesktopShell';
import { SavedLinks } from './SavedLinks';
import {
  isFavoritePortal,
  loadActiveThread,
  loadContextOpen,
  loadFavoritePortals,
  loadRecentPortals,
  rememberPortal,
  saveActiveThread,
  saveContextOpen,
  saveFavoritePortals,
  saveRecentPortals,
  toggleFavoritePortal,
} from '../../../application/shell';

const NYM_API_URL = 'https://validator.nymtech.net/api';
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

/** Self-contained representation of a top-level image/binary response. */
function dataUrlFor(bytes: Uint8Array, contentType: string): string {
  const type =
    String(contentType ?? '')
      .split(';')[0]
      .trim() || 'application/octet-stream';
  return `data:${type};base64,${b64encode(bytes)}`;
}

/** Save bytes through a temporary object URL and an anchor download. */
function saveBlob(bytes: Uint8Array, contentType: string, name: string): void {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: contentType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name || 'download';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Save a top-level response without navigating to a `data:` URL. */
function downloadDataUrl(dataUrl: string, name: string): number | null {
  const match = /^data:([^;,]*);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const bytes = b64decode(match[2]);
  saveBlob(bytes, match[1] || 'application/octet-stream', name);
  return bytes.length;
}

/** Decode a text-ish `data:` URL for an embedded document preview. */
function textFromDataUrl(dataUrl: string): string {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return '';
  try {
    return match[2] ? new TextDecoder().decode(b64decode(match[3])) : decodeURIComponent(match[3]);
  } catch {
    return '';
  }
}

const DOWNLOAD_EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/json': '.json',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

function downloadName(title: string, contentType: string, serverName?: string | null): string {
  const heading = (serverName || title || 'download').trim();
  const base =
    heading
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s_]+|[.\s_]+$/g, '') || 'download';
  const type = contentType.split(';')[0].trim().toLowerCase();
  const extension = DOWNLOAD_EXTENSIONS[type] ?? '';
  return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
}

/** Download metadata from a GET or HEAD response. */
interface DownloadMeta {
  contentType: string;
  total: number | null;
  etag: string | null;
  acceptRanges: boolean;
  filename: string | null;
  url: string;
}

function metaFromHeaders(headers: HeaderRecord, url = ''): DownloadMeta {
  return {
    contentType: headerValue(headers, 'content-type'),
    total: responseTotal(headers) ?? parseContentLength(headerValue(headers, 'content-length')),
    etag: responseValidators(headers).etag,
    acceptRanges: /(^|,)\s*bytes\s*(,|$)/i.test(headerValue(headers, 'accept-ranges')),
    filename: filenameFromDisposition(headerValue(headers, 'content-disposition')),
    url,
  };
}

/** A pending `401` prompt, bound to the tab that hit it. */
interface AuthPrompt {
  tabId: string;
  target: NavigationTarget;
  scope: string;
  challenge: AuthChallenge;
  wrong: boolean;
}

/** Partial download bytes are session-only; keep the retained set bounded. */
const MAX_RETAINED_DOWNLOAD_BYTES = 64 * 1024 * 1024;

function retainPartialDownload(map: Map<string, Uint8Array>, id: string, bytes: Uint8Array): void {
  map.delete(id);
  map.set(id, bytes);
  let total = 0;
  for (const value of map.values()) total += value.length;
  for (const key of map.keys()) {
    if (total <= MAX_RETAINED_DOWNLOAD_BYTES || map.size <= 1) break;
    const value = map.get(key);
    if (!value) continue;
    map.delete(key);
    total -= value.length;
  }
}

export function App() {
  const [status, setStatus] = useState<TunnelStateView>({ state: 'shutdown' });
  // Set once the tunnel has been torn down. Phase 4 offers an in-place
  // reconnect first; the hard-reload button remains as the SDK fallback.
  const [spent, setSpent] = useState(() => tunnelSpent());
  const [reconnectEpoch, setReconnectEpoch] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [clearnetIp, setClearnetIp] = useState<string>('');
  const [mixnetIp, setMixnetIp] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [exit, setExit] = useState(() => exitStatus());
  const [lastError, setLastError] = useState<unknown>(null);

  // Primary navigation (persisted). Technical panels keep their own
  // persistence underneath, inside Settings → Advanced.
  const [view, setView] = useState<ViewId>(() => loadActiveView(defaultViewStorage()));
  const [advanced, setAdvanced] = useState(() => loadAdvancedVisible(defaultViewStorage()));
  const [onboarded, setOnboarded] = useState(() => loadOnboarded(defaultViewStorage()));

  // Direct Nym-address messaging state.
  const clientRef = useRef<NymAddressClient | null>(null);
  const [selfAddress, setSelfAddress] = useState('');
  const [recipient, setRecipient] = useState('');
  const [draft, setDraft] = useState('');
  const [inbox, setInbox] = useState<IncomingMessage[]>([]);
  // Restored on load so the roster reopens where you left off.
  const [activeThread, setActiveThread] = useState<string | null>(() => loadActiveThread(defaultViewStorage()));
  // Per-thread read watermarks (session-only): inbox size seen while open.
  const [readCounts, setReadCounts] = useState<Record<string, number>>({});

  // Hidden-service fetch state (fetchNym: one call, one response).
  const [hsAddress, setHsAddress] = useState('');
  const [hsPath, setHsPath] = useState('/');
  const [hsResult, setHsResult] = useState('');

  // Browser tabs/documents. The model lives in `application/browser.ts`; this
  // component only orchestrates I/O and rendering. Restore URLs/history from
  // the previous session (page bodies are intentionally not persisted).
  const initialBrowserRef = useRef<ReturnType<typeof loadBrowserTabs> | null>(null);
  if (!initialBrowserRef.current) initialBrowserRef.current = loadBrowserTabs(defaultStorage());
  const initialBrowser = initialBrowserRef.current;
  const [tabs, setTabs] = useState<BrowserTab[]>(initialBrowser.tabs);
  const [activeTabId, setActiveTabId] = useState(initialBrowser.activeId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  // The Social section binds to the active tab only; clearnet tabs never do.
  const socialService = activeTab?.service ?? '';
  // Recently opened portals for the desktop roster, newest first.
  const [recentPortals, setRecentPortals] = useState<string[]>(() => loadRecentPortals(defaultViewStorage()));
  // Favourited portals: pinned above the recents in the roster, persisted.
  const [favorites, setFavorites] = useState<string[]>(() => loadFavoritePortals(defaultViewStorage()));
  // Desktop context panel visibility (persisted; narrow screens ignore it).
  const [contextOpen, setContextOpen] = useState(() => loadContextOpen(defaultViewStorage()));

  // Contacts: local-only address book + pending invite from the URI bar.
  const [contacts, setContacts] = useState<Contact[]>(() => loadContacts(defaultContactStorage()));
  const [pendingInvite, setPendingInvite] = useState<PendingInvite | null>(null);

  // Named private-link bookmarks (device-local), shown in the Portal view.
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => loadBookmarks(defaultBookmarkStorage()));
  const [bookmarkName, setBookmarkName] = useState('');
  const [showBookmarkField, setShowBookmarkField] = useState(false);

  // Local web-of-trust: explicit Trust/Block verdicts per author. Owned here
  // (not in Social) so both the timeline and the invite banner can read and
  // write them. Everything stays on this device.
  const [trustMap, setTrustMap] = useState<Record<string, Verdict>>(() => loadTrust(defaultTrustStorage()));

  const onVerdict = useCallback((author: string, verdict: Verdict | null) => {
    setTrustMap((prev) => {
      const next = withVerdict(prev, author, verdict);
      saveTrust(next, defaultTrustStorage());
      return next;
    });
  }, []);

  const [petname, setPetname] = useState('');

  // Unified address bar. `navigate()` decides between fetchNym (nym://) and
  // mixnetFetch (http/https); the active tab owns the resulting document.
  const [uri, setUri] = useState(initialBrowser.tabs.find((tab) => tab.id === initialBrowser.activeId)?.url ?? '');
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const navigationSeqRef = useRef(0);
  const activeLoadsRef = useRef(0);
  const bootRestoredRef = useRef(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const linkedFrameDocsRef = useRef(new WeakSet<Document>());
  const documentCacheRef = useRef(new DocumentCache());
  const cookieJarRef = useRef<CookieJar | null>(null);
  if (!cookieJarRef.current) cookieJarRef.current = loadCookieJar(defaultStorage());
  const credentialsRef = useRef<CredentialStore | null>(null);
  if (!credentialsRef.current) credentialsRef.current = new CredentialStore();
  /** One AbortController per tab: Stop/new navigation aborts the transport. */
  const abortRef = useRef(new Map<string, AbortController>());
  /** Bytes retained for a paused download, keyed by download id (session only). */
  const downloadPartsRef = useRef(new Map<string, Uint8Array>());
  /** Download ids with a transfer currently running (prevents double-start). */
  const activeDownloadsRef = useRef(new Set<string>());
  /** Response metadata from the document GET, used to name/prefill downloads. */
  const pageMetaRef = useRef(new Map<string, DownloadMeta>());
  /** mix-fetch's `Response` shim cannot represent a null-body 304; fall back. */
  const clearnetConditionalBrokenRef = useRef(false);
  const [downloads, setDownloads] = useState<DownloadRecord[]>(() => loadDownloads(defaultStorage()));
  const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null);
  const [authUser, setAuthUser] = useState('');
  const [authPass, setAuthPass] = useState('');
  const [authError, setAuthError] = useState('');

  // Phase 4 browser controls.
  const [zoom, setZoom] = useState(() => loadZoom(defaultStorage()));
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findCount, setFindCount] = useState(0);
  const [findIndex, setFindIndex] = useState(-1);
  const findMarksRef = useRef<HTMLElement[]>([]);
  const findIndexRef = useRef(-1);
  const findOpenRef = useRef(false);
  const findQueryRef = useRef('');
  findOpenRef.current = findOpen;
  findQueryRef.current = findQuery;
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const permissionRegistryRef = useRef<PermissionRegistry | null>(null);
  if (!permissionRegistryRef.current) permissionRegistryRef.current = loadPermissions(defaultStorage());
  const [, setPermissionVersion] = useState(0);
  const [online, setOnline] = useState(() => isOnline());
  const [swControlled, setSwControlled] = useState(false);
  const [initialDeepLink] = useState(() => takeInitialDeepLink());
  const [embeddedPreview, setEmbeddedPreview] = useState<{
    document: EmbeddedDocument;
    loading: boolean;
    dataUrl?: string;
    text?: string;
    error?: string;
  } | null>(null);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-99), `${new Date().toLocaleTimeString()}  ${line}`]);
  }, []);

  // One-tap trust for IDs an inviter vouched for. The invite signature
  // already proved the inviter said it — this records your own call.
  // Declared after `append` since it logs the result.
  const onTrustVouched = useCallback(
    (authors: string[]) => {
      setTrustMap((prev) => {
        let next = prev;
        for (const author of authors) next = withVerdict(next, author, 'trusted');
        try {
          saveTrust(next, localStorage);
        } catch {
          // Private mode: verdicts just don't persist.
        }
        return next;
      });
      append(`trusted ${authors.length} vouched ${authors.length === 1 ? 'ID' : 'IDs'}`);
    },
    [append],
  );

  // Keep the UI status honest.
  const exitWarnedRef = useRef(false);
  useEffect(() => {
    const id = window.setInterval(() => {
      void tunnelState().then(setStatus);
      const next = exitStatus();
      // Surface the exit-rotation advisory once, at the threshold crossing —
      // the policy itself can only warn (the tunnel is one-shot, §5.2.2).
      if (next.recommendReconnect && !exitWarnedRef.current) {
        exitWarnedRef.current = true;
        append(`exit reuse: ${next.requests} requests on one exit — reconnect to rotate your exit (§5.2.2)`);
      }
      setExit(next);
    }, 2000);
    return () => window.clearInterval(id);
  }, [append]);

  // Connectivity + offline-shell status for the banner/toolbar.
  useEffect(() => watchConnectivity(setOnline), []);
  useEffect(() => {
    if (!serviceWorkerSupported()) return;
    const update = () => setSwControlled(Boolean(navigator.serviceWorker.controller));
    update();
    navigator.serviceWorker.addEventListener('controllerchange', update);
    return () => navigator.serviceWorker.removeEventListener('controllerchange', update);
  }, []);

  // Keep the Android process alive (foreground service + notification) while the
  // tunnel is up, so Doze/App Standby cannot suspend it; stop it once the tunnel
  // is gone. No-op off Android (foreground.mjs degrades to {available:false}).
  useEffect(() => {
    if (spent || status.state === 'failed' || status.state === 'shutdown') {
      void stopForeground();
    } else if (status.state === 'ready') {
      void startForeground();
    }
  }, [status.state, spent]);

  const onSelectView = useCallback((next: ViewId) => {
    setView(next);
    saveActiveView(next, defaultViewStorage());
  }, []);

  const onToggleAdvanced = useCallback((next: boolean) => {
    setAdvanced(next);
    saveAdvancedVisible(next, defaultViewStorage());
  }, []);

  const onDismissOnboarding = useCallback(() => {
    setOnboarded(true);
    saveOnboarded(true, defaultViewStorage());
  }, []);

  // Roster continuity: remember the open thread and panel across loads.
  useEffect(() => {
    saveActiveThread(activeThread, defaultViewStorage());
  }, [activeThread]);

  const onToggleContext = useCallback(() => {
    setContextOpen((prev) => {
      saveContextOpen(!prev, defaultViewStorage());
      return !prev;
    });
  }, []);

  const onSelectThread = useCallback(
    (key: string) => {
      setActiveThread(key);
      if (isContactThread(key)) {
        setRecipient(contactAddressOf(key));
      }
      onSelectView('messages');
    },
    [onSelectView],
  );

  const onConnect = useCallback(async () => {
    setBusy(true);
    setLastError(null);
    try {
      append('bringing up mixnet tunnel…');
      await ensureTunnel({ debug: import.meta.env.DEV });
      setStatus(await tunnelState());
      append('tunnel requested');
    } catch (err) {
      setLastError(err);
      append(`tunnel error: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [append]);

  const onDisconnect = useCallback(async () => {
    setBusy(true);
    try {
      await teardownTunnel();
      setSpent(tunnelSpent());
      append('tunnel torn down — reconnect to start a fresh one');
      setStatus(await tunnelState());
    } catch (err) {
      setLastError(err);
    } finally {
      setBusy(false);
    }
  }, [append]);

  /**
   * Rebuild the tunnel in place. Tabs/history/documents stay mounted; only the
   * transport and its per-request clients are reset. If the runtime refuses to
   * recreate the WASM instance, `lastError` explains and the UI offers a hard
   * reload fallback.
   */
  const onReconnect = useCallback(async () => {
    setBusy(true);
    setLastError(null);
    try {
      append('reconnecting tunnel in place…');
      await stopFetchNymClient();
      await reconnectTunnel({ debug: import.meta.env.DEV });
      resetExitPolicy();
      exitWarnedRef.current = false;
      setSpent(tunnelSpent());
      setStatus(await tunnelState());
      setExit(exitStatus());
      append('tunnel reconnected; tabs and history preserved');
      setReconnectEpoch((value) => value + 1);
    } catch (err) {
      setSpent(tunnelSpent());
      setLastError(err);
      append(`reconnect failed: ${String(err)} — a reload is required if this persists`);
    } finally {
      setBusy(false);
    }
  }, [append]);

  const onHardReload = useCallback(() => {
    window.location.reload();
  }, []);

  const onProveTunnel = useCallback(async () => {
    setBusy(true);
    setLastError(null);
    try {
      const { clearnet, mixnet, differ } = await proveTunnel('https://api.ipify.org?format=json');
      setClearnetIp(clearnet);
      setMixnetIp(mixnet);
      append(`clearnet=${clearnet} mixnet=${mixnet} differ=${differ}`);
    } catch (err) {
      setLastError(err);
      append(`proof failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [append]);

  const onStartMessaging = useCallback(async () => {
    setBusy(true);
    setLastError(null);
    try {
      const client = clientRef.current ?? new NymAddressClient();
      clientRef.current = client;
      const address = await client.start(
        NYM_API_URL,
        (msg) => setInbox((prev) => [...prev, msg]),
        (reason) => append(`inbound reply rejected: ${reason}`),
      );
      setSelfAddress(address);
      append(`Nym-address client ready: ${address}`);
    } catch (err) {
      setLastError(err);
      append(`messaging start failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [append]);

  const onSend = useCallback(async () => {
    if (!clientRef.current || !recipient || !draft) return;
    setLastError(null);
    try {
      await clientRef.current.send(recipient, draft);
      append(`sent to ${recipient}`);
      setDraft('');
    } catch (err) {
      setLastError(err);
      append(`send failed: ${String(err)}`);
    }
  }, [recipient, draft, append]);

  const onReply = useCallback(
    async (msg: IncomingMessage) => {
      if (!clientRef.current || !msg.senderTag) return;
      try {
        await clientRef.current.reply(msg.senderTag, `re: ${msg.text}`);
        append('anonymous SURB reply sent');
      } catch (err) {
        setLastError(err);
        append(`reply failed: ${String(err)}`);
      }
    },
    [append],
  );

  const onFetchNym = useCallback(async () => {
    if (!hsAddress || !hsPath) return;
    setBusy(true);
    setLastError(null);
    try {
      append(`fetchNym ${hsPath} @ ${hsAddress.slice(0, 12)}…`);
      const res = await fetchNymFull(
        hsAddress,
        { method: 'GET', path: hsPath },
        { timeoutMs: 120_000, maxBytes: MAX_PAGE_BYTES },
      );
      const bytes = await decodeContentEncoding(res.body, headerValue(res.headers, 'content-encoding'));
      const text = new TextDecoder().decode(bytes);
      setHsResult(`status=${res.status} error=${res.error ?? 'none'}\n${text.slice(0, 2000)}`);
      append(`fetchNym done: status=${res.status} body=${bytes.length}B`);
    } catch (err) {
      setLastError(err);
      append(`fetchNym failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [hsAddress, hsPath, append]);

  // Petnames (contacts) are resolved in the address bar, case-insensitively.
  const navigationPetnames = useMemo(
    () =>
      Object.fromEntries(
        contacts
          .map((contact) => [contact.name.trim().toLowerCase(), contact.address] as const)
          .filter(([name, address]) => Boolean(name && address)),
      ),
    [contacts],
  );

  const permissionScope = useMemo(
    () => (activeTab?.url ? permissionScopeFor(activeTab.url) : 'app'),
    [activeTab?.url],
  );
  const textFindMatches = useMemo(() => {
    const content = activeTab?.content;
    if (!content || content.kind === 'html') return [];
    return findMatches(content.body.slice(0, 200_000), findQuery);
  }, [activeTab?.content, findQuery]);

  /** mixnetFetch + cookies + auth + redirect chain for clearnet requests. */
  const requestClearnet = useCallback(async (url: string, init?: RequestInit): Promise<ClearnetResult> => {
    const jar = cookieJarRef.current;
    try {
      return await clearnetFetch(url, init, {
        fetch: mixnetFetch,
        jar: jar ?? undefined,
        credentials: credentialsRef.current ?? undefined,
      });
    } finally {
      // Redirect hops may have updated the jar even if a later hop failed.
      if (jar) saveCookieJar(defaultStorage(), jar);
    }
  }, []);

  /**
   * Fetch one page subresource through the same transport as the document.
   * The content loader only ever receives this callback, never native fetch.
   */
  const fetchSubresource = useCallback(
    async (url: string, kind: ResourceKind, signal?: AbortSignal): Promise<ResourceResponse | null> => {
      let target: NavigationTarget;
      try {
        target = resolveNavigationInput(url);
      } catch {
        return null;
      }
      const accept =
        kind === 'image'
          ? 'image/*,*/*;q=0.8'
          : kind === 'stylesheet'
            ? 'text/css,*/*;q=0.1'
            : kind === 'media'
              ? 'audio/*,video/*,*/*;q=0.1'
              : kind === 'document'
                ? 'application/pdf,text/*,application/json;q=0.9,*/*;q=0.5'
                : '*/*';
      try {
        if (target.kind === 'nym') {
          const headers: Record<string, string> = { accept };
          const authorization = credentialsRef.current?.authorizationFor(target.address) ?? '';
          if (authorization) headers.authorization = authorization;
          const res = await fetchNymFull(
            target.address,
            { method: 'GET', path: target.path, headers },
            {
              timeoutMs: 30_000,
              maxBytes: kind === 'other' || kind === 'document' ? 32 * 1024 * 1024 : 4 * 1024 * 1024,
              signal,
            },
          );
          if (res.error || res.status >= 400) return null;
          const body = await decodeContentEncoding(res.body, headerValue(res.headers, 'content-encoding'));
          return { status: res.status, contentType: headerValue(res.headers, 'content-type'), bytes: body };
        }
        const result = await requestClearnet(url, { headers: { accept }, signal });
        if (result.response.status >= 400) return null;
        const headers = headersToRecord(result.response.headers);
        const raw = new Uint8Array(await result.response.arrayBuffer());
        const bytes = await decodeContentEncoding(raw, headerValue(headers, 'content-encoding'));
        return { status: result.response.status, contentType: headerValue(headers, 'content-type'), bytes };
      } catch {
        return null;
      }
    },
    [requestClearnet],
  );

  /** Surface a `401` as an in-page sign-in card instead of a page error. */
  const requestAuth = useCallback(
    (tabId: string, target: NavigationTarget, token: number, challenge: AuthChallenge, wrong: boolean) => {
      const scope = authScopeFor(target.kind === 'nym' ? target.address : target.url);
      setTabs((prev) => prev.map((tab) => (tab.id === tabId ? settlePage(tab, token) : tab)));
      setAuthPrompt({ tabId, target, scope, challenge, wrong });
      setAuthUser('');
      setAuthPass('');
      setAuthError(wrong ? 'That username and password were not accepted.' : '');
      append(
        wrong
          ? `sign-in failed for ${scope}`
          : `${scope} needs sign-in (${challenge.label}${challenge.realm ? `, realm “${challenge.realm}”` : ''})`,
      );
    },
    [append],
  );

  /**
   * HEAD probe for obvious media/PDF URLs. When the range bridge is active this
   * avoids downloading the whole file just to discover it is playable.
   */
  const probeStreamTarget = useCallback(
    async (target: NavigationTarget, signal?: AbortSignal): Promise<DownloadMeta | null> => {
      if (!mediaStreamingAvailable() || !looksLikeStreamableUrl(target.url)) return null;
      try {
        if (target.kind === 'nym') {
          const headers: Record<string, string> = { accept: '*/*' };
          const authorization = credentialsRef.current?.authorizationFor(target.address) ?? '';
          if (authorization) headers.authorization = authorization;
          const res = await fetchNym(
            target.address,
            { method: 'HEAD', path: target.path, headers },
            { timeoutMs: 30_000, signal },
          );
          if (res.error || res.status >= 400) return null;
          const meta = metaFromHeaders(res.headers ?? {}, target.url);
          return isStreamableContentType(meta.contentType) ? meta : null;
        }
        const result = await requestClearnet(target.url, {
          method: 'HEAD',
          headers: { accept: '*/*', 'accept-encoding': 'identity' },
          signal,
        });
        if (result.response.status >= 400) return null;
        const meta = metaFromHeaders(
          headersToRecord(result.response.headers),
          result.url || target.url,
        );
        return isStreamableContentType(meta.contentType) ? meta : null;
      } catch {
        return null;
      }
    },
    [requestClearnet],
  );

  /**
   * Execute one resolved navigation into one tab. Callers own the history
   * decision and the navigation token; this function only does I/O + guarded
   * state updates.
   */
  const loadInto = useCallback(
    async (
      target: NavigationTarget,
      tabId: string,
      options: {
        push: boolean;
        historyIndex?: number;
        token: number;
        force?: boolean;
        redirects?: number;
        signal?: AbortSignal;
      },
    ) => {
      if (options.signal?.aborted) return;
      setLastError(null);
      setNavigationError(null);
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? navigateTab(tab, target, {
                push: options.push,
                historyIndex: options.historyIndex,
                token: options.token,
              })
            : tab,
        ),
      );
      setUri(target.url);

      const cached = documentCacheRef.current.get(target.url);
      if (cached && !options.force) {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId
              ? applyPage(tab, options.token, {
                  status: cached.status,
                  contentType: cached.contentType,
                  body: cached.body,
                  favicon: cached.favicon,
                  embedded: cached.embedded,
                  mediaUrl: cached.mediaUrl,
                  mediaTotal: cached.mediaTotal,
                  mediaEtag: cached.mediaEtag,
                })
              : tab,
          ),
        );
        return;
      }
      // Reload/back-forward revalidation: ask the origin whether the cached
      // body is still current. A 304 reuses the prepared document.
      const conditional = cached ? conditionalRequestHeaders(cached) : {};

      // Media/PDF candidates are probed with HEAD so the range bridge can play
      // them without buffering the entire representation first.
      const streamMeta = await probeStreamTarget(target, options.signal);
      if (options.signal?.aborted) return;
      if (streamMeta) {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId
              ? applyPage(tab, options.token, {
                  status: 200,
                  contentType: streamMeta.contentType,
                  body: '',
                  favicon: null,
                  embedded: [],
                  mediaUrl: streamMeta.url || target.url,
                  mediaTotal: streamMeta.total,
                  mediaEtag: streamMeta.etag,
                })
              : tab,
          ),
        );
        documentCacheRef.current.set(target.url, {
          status: 200,
          contentType: streamMeta.contentType,
          body: '',
          favicon: null,
          embedded: [],
          mediaUrl: streamMeta.url || target.url,
          mediaTotal: streamMeta.total,
          mediaEtag: streamMeta.etag,
          etag: streamMeta.etag,
          lastModified: null,
          finalUrl: streamMeta.url || target.url,
        });
        pageMetaRef.current.set(target.url, streamMeta);
        append(`streaming ${streamMeta.contentType} through the range bridge`);
        return;
      }

      activeLoadsRef.current += 1;
      setBusy(true);

      const applyCached = (status: number) => {
        if (!cached) return false;
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId
              ? applyPage(tab, options.token, {
                  status,
                  contentType: cached.contentType,
                  body: cached.body,
                  favicon: cached.favicon,
                  embedded: cached.embedded,
                  mediaUrl: cached.mediaUrl,
                  mediaTotal: cached.mediaTotal,
                  mediaEtag: cached.mediaEtag,
                })
              : tab,
          ),
        );
        return true;
      };

      if (target.kind === 'nym') {
        if (target.invite) {
          const invite = target.invite as ParsedInvite;
          setPendingInvite({
            address: target.address,
            path: target.path,
            inviter: invite.inviter,
            note: invite.note,
            invite,
          });
          setPetname('');
          append(`invite from ${invite.inviter.slice(0, 12)}…: “${invite.note}”`);
        }
        append(`nym:// fetch ${target.path} @ ${target.address.slice(0, 12)}…`);
        try {
          const headers: Record<string, string> = { accept: 'text/html', ...conditional };
          const authorization = credentialsRef.current?.authorizationFor(target.address) ?? '';
          if (authorization) headers.authorization = authorization;
          const res = await fetchNymFull(
            target.address,
            { method: 'GET', path: target.path, headers },
            { timeoutMs: 120_000, maxBytes: MAX_PAGE_BYTES, signal: options.signal },
          );
          if (options.signal?.aborted) return;
          const resHeaders = res.headers ?? {};

          if (res.status === 401) {
            const challenge = parseAuthChallenge(headerValue(resHeaders, 'www-authenticate'));
            if (challenge) {
              requestAuth(tabId, target, options.token, challenge, Boolean(authorization));
              return;
            }
          }
          if (res.status === 304) {
            if (applyCached(cached?.status ?? 200)) {
              append(`nym:// not modified (304) ${target.path}`);
              return;
            }
          }
          if (!res.error && res.status >= 300 && res.status < 400 && headerValue(resHeaders, 'location')) {
            const redirects = (options.redirects ?? 0) + 1;
            if (redirects > 5) {
              setTabs((prev) =>
                prev.map((tab) => (tab.id === tabId ? failPage(tab, options.token, 'too many redirects') : tab)),
              );
              return;
            }
            let next: NavigationTarget;
            try {
              next = resolveNavigationInput(
                new URL(headerValue(resHeaders, 'location'), target.url).toString(),
                { petnames: navigationPetnames },
              );
            } catch (redirectError) {
              setTabs((prev) =>
                prev.map((tab) =>
                  tab.id === tabId ? failPage(tab, options.token, `bad redirect: ${String(redirectError)}`) : tab,
                ),
              );
              return;
            }
            append(`redirect ${res.status} -> ${next.url}`);
            await loadInto(next, tabId, {
              push: false,
              token: options.token,
              redirects,
              signal: options.signal,
            });
            return;
          }
          if (res.error) {
            setTabs((prev) => prev.map((tab) => (tab.id === tabId ? failPage(tab, options.token, res.error ?? '') : tab)));
            setHsResult(`status=${res.status} error=${res.error}`);
            append(`nym:// done with service error: ${res.error}`);
            return;
          }
          const decoded = await decodeContentEncoding(res.body, headerValue(resHeaders, 'content-encoding'));
          if (options.signal?.aborted) return;
          if (decoded.length > MAX_PAGE_BYTES) {
            setTabs((prev) =>
              prev.map((tab) =>
                tab.id === tabId ? failPage(tab, options.token, `page is too large (${decoded.length} bytes)`) : tab,
              ),
            );
            append(`nym:// page too large: ${decoded.length} bytes`);
            return;
          }
          const contentType = headerValue(resHeaders, 'content-type');
          const text = new TextDecoder().decode(decoded);
          const kind = pageKindFor(contentType, text);
          let body = text;
          let effectiveType = contentType;
          let favicon: string | null = null;
          let embedded: EmbeddedDocument[] = [];
          if (kind === 'image' || kind === 'media' || kind === 'pdf' || kind === 'binary') {
            body = dataUrlFor(decoded, contentType);
          } else if (kind === 'html') {
            try {
              const prepared = await prepareDocument(text, target.url, fetchSubresource, { signal: options.signal });
              if (options.signal?.aborted) return;
              body = prepared.html;
              effectiveType = 'text/html; charset=utf-8';
              favicon = prepared.favicon;
              embedded = prepared.embedded;
              if (prepared.stats.resources > 0) {
                append(
                  `page assets: ${prepared.stats.resources} fetched, ${prepared.stats.failed} unavailable` +
                    (prepared.stats.truncated ? ' (capped)' : ''),
                );
              }
            } catch (err) {
              if (options.signal?.aborted || isAbortError(err)) return;
              setTabs((prev) =>
                prev.map((tab) =>
                  tab.id === tabId ? failPage(tab, options.token, `could not prepare this page: ${String(err)}`) : tab,
                ),
              );
              setLastError(err);
              append(`page prepare failed: ${String(err)}`);
              return;
            }
          }
          const validators = responseValidators(resHeaders);
          setTabs((prev) =>
            prev.map((tab) =>
              tab.id === tabId
                ? applyPage(tab, options.token, {
                    status: res.status,
                    contentType: effectiveType,
                    body,
                    favicon,
                    embedded,
                  })
                : tab,
            ),
          );
          documentCacheRef.current.set(target.url, {
            status: res.status,
            contentType: effectiveType,
            body,
            favicon,
            embedded,
            ...validators,
            finalUrl: target.url,
          });
          const meta = metaFromHeaders(resHeaders, target.url);
          pageMetaRef.current.set(target.url, { ...meta, total: meta.total ?? decoded.length });
          setRecentPortals((prev) => {
            const next = rememberPortal(prev, target.address);
            saveRecentPortals(next, defaultViewStorage());
            return next;
          });
          setHsResult(`status=${res.status} body=${decoded.length}B (rendered in the tab)`);
          append(`nym:// done: status=${res.status} body=${decoded.length}B`);
        } catch (err) {
          if (options.signal?.aborted || isAbortError(err)) return;
          setTabs((prev) => prev.map((tab) => (tab.id === tabId ? failPage(tab, options.token, String(err)) : tab)));
          setLastError(err);
          append(`nym:// failed: ${String(err)}`);
        } finally {
          activeLoadsRef.current = Math.max(0, activeLoadsRef.current - 1);
          setBusy(activeLoadsRef.current > 0);
        }
        return;
      }

      append(`https fetch ${target.url}`);
      try {
        let result: ClearnetResult;
        // The mix-fetch shim wraps the WASM reply in a DOM `Response`; status
        // 304 requires a null body and throws there. Disable conditional
        // clearnet requests for the session after the first such failure.
        const conditionalClearnet = clearnetConditionalBrokenRef.current ? {} : conditional;
        try {
          result = await requestClearnet(target.url, { headers: conditionalClearnet, signal: options.signal });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const unsupported304 =
            Object.keys(conditionalClearnet).length > 0 &&
            !options.signal?.aborted &&
            /invalid response status code 304/i.test(message);
          if (!unsupported304) throw err;
          clearnetConditionalBrokenRef.current = true;
          append('clearnet transport cannot represent 304; conditional reloads disabled for this session');
          result = await requestClearnet(target.url, { signal: options.signal });
        }
        if (options.signal?.aborted) return;
        const res = result.response;
        const resHeaders = headersToRecord(res.headers);
        if (result.authChallenge) {
          requestAuth(tabId, target, options.token, result.authChallenge, result.authenticated);
          return;
        }
        if (res.status === 304) {
          if (applyCached(cached?.status ?? 200)) {
            append(`web not modified (304) ${target.url}`);
            return;
          }
        }
        const raw = new Uint8Array(await res.arrayBuffer());
        if (options.signal?.aborted) return;
        const bytes = await decodeContentEncoding(raw, headerValue(resHeaders, 'content-encoding'));
        if (options.signal?.aborted) return;
        if (bytes.length > MAX_PAGE_BYTES) {
          setTabs((prev) =>
            prev.map((tab) =>
              tab.id === tabId ? failPage(tab, options.token, `page is too large (${bytes.length} bytes)`) : tab,
            ),
          );
          append(`web page too large: ${bytes.length} bytes`);
          return;
        }
        const contentType = headerValue(resHeaders, 'content-type');
        const decoded = new TextDecoder().decode(bytes);
        const kind = pageKindFor(contentType, decoded);
        const text = kind === 'image' || kind === 'media' || kind === 'pdf' || kind === 'binary' ? '' : decoded;
        let body = text;
        let effectiveType = contentType;
        let favicon: string | null = null;
        let embedded: EmbeddedDocument[] = [];
        if (kind === 'image' || kind === 'media' || kind === 'pdf' || kind === 'binary') {
          body = dataUrlFor(bytes, contentType);
        } else if (kind === 'html') {
          try {
            // `mixnetFetch` follows redirects; resolve relative assets against
            // the final document URL, not the one the user typed.
            const documentUrl = result.url || res.url || target.url;
            const prepared = await prepareDocument(text, documentUrl, fetchSubresource, { signal: options.signal });
            if (options.signal?.aborted) return;
            body = prepared.html;
            effectiveType = 'text/html; charset=utf-8';
            favicon = prepared.favicon;
            embedded = prepared.embedded;
            if (prepared.stats.resources > 0) {
              append(
                `page assets: ${prepared.stats.resources} fetched, ${prepared.stats.failed} unavailable` +
                  (prepared.stats.truncated ? ' (capped)' : ''),
              );
            }
          } catch (err) {
            if (options.signal?.aborted || isAbortError(err)) return;
            setTabs((prev) =>
              prev.map((tab) =>
                tab.id === tabId ? failPage(tab, options.token, `could not prepare this page: ${String(err)}`) : tab,
              ),
            );
            setLastError(err);
            append(`page prepare failed: ${String(err)}`);
            return;
          }
        }
        if (res.status >= 400 && !body) {
          setTabs((prev) =>
            prev.map((tab) => (tab.id === tabId ? failPage(tab, options.token, `server returned ${res.status}`) : tab)),
          );
          append(`web error: status=${res.status}`);
          return;
        }
        const validators = responseValidators(resHeaders);
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId
              ? applyPage(tab, options.token, {
                  status: res.status,
                  contentType: effectiveType,
                  body,
                  favicon,
                  embedded,
                })
              : tab,
          ),
        );
        documentCacheRef.current.set(target.url, {
          status: res.status,
          contentType: effectiveType,
          body,
          favicon,
          embedded,
          ...validators,
          finalUrl: result.url || target.url,
        });
        const meta = metaFromHeaders(resHeaders, result.url || target.url);
        pageMetaRef.current.set(target.url, { ...meta, total: meta.total ?? bytes.length });
        setHsResult(`status=${res.status} body=${body.length}B (rendered in the tab)`);
        append(`web done: status=${res.status} body=${body.length}B`);
      } catch (err) {
        if (options.signal?.aborted || isAbortError(err)) return;
        setTabs((prev) => prev.map((tab) => (tab.id === tabId ? failPage(tab, options.token, String(err)) : tab)));
        setLastError(err);
        append(`web failed: ${String(err)}`);
      } finally {
        activeLoadsRef.current = Math.max(0, activeLoadsRef.current - 1);
        setBusy(activeLoadsRef.current > 0);
      }
    },
    [append, fetchSubresource, navigationPetnames, probeStreamTarget, requestAuth, requestClearnet],
  );

  /**
   * Start a navigation for a tab: abort the previous transport, mint a token,
   * and clear any auth prompt that belonged to the superseded load.
   */
  const beginNavigation = useCallback((tabId: string) => {
    abortRef.current.get(tabId)?.abort();
    const controller = new AbortController();
    abortRef.current.set(tabId, controller);
    setAuthPrompt((prev) => (prev && prev.tabId === tabId ? null : prev));
    return { token: (navigationSeqRef.current += 1), controller, signal: controller.signal };
  }, []);

  const goTo = useCallback(
    async (raw: string) => {
      if (!raw.trim()) return;
      let target: NavigationTarget;
      try {
        target = resolveNavigationInput(raw, { petnames: navigationPetnames });
      } catch (err) {
        setNavigationError(err instanceof Error ? err.message : String(err));
        append(`navigation: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const tabId = activeTab?.id ?? tabs[0]?.id;
      if (!tabId) return;
      const { token, signal } = beginNavigation(tabId);
      onSelectView('portal');
      await loadInto(target, tabId, { push: true, token, signal });
    },
    [activeTab?.id, append, beginNavigation, loadInto, navigationPetnames, onSelectView, tabs],
  );

  const onGo = useCallback(() => {
    void goTo(uri);
  }, [goTo, uri]);

  const onAddressChange = useCallback((value: string) => {
    setUri(value);
    setNavigationError(null);
  }, []);

  /* ---------------------------------------------------------- page tools */

  const applyZoom = useCallback((value: number) => {
    const next = clampZoom(value);
    setZoom(next);
    saveZoom(defaultStorage(), next);
  }, []);

  const onZoomIn = useCallback(() => applyZoom(nextZoom(zoom, 1)), [applyZoom, zoom]);
  const onZoomOut = useCallback(() => applyZoom(nextZoom(zoom, -1)), [applyZoom, zoom]);
  const onZoomReset = useCallback(() => applyZoom(1), [applyZoom]);

  const runFindOnDoc = useCallback((doc: Document | null, query: string) => {
    const marks = doc ? highlightFindMatches(doc, query) : [];
    findMarksRef.current = marks;
    const index = marks.length > 0 ? 0 : -1;
    findIndexRef.current = index;
    setFindCount(marks.length);
    setFindIndex(index);
    if (index >= 0) focusFindMatch(marks, index);
  }, []);

  const onFindQuery = useCallback((value: string) => setFindQuery(value), []);
  const onFindClose = useCallback(() => {
    setFindOpen(false);
    const doc = frameRef.current?.contentDocument;
    if (doc) clearFindHighlights(doc);
    findMarksRef.current = [];
    findIndexRef.current = -1;
    setFindCount(0);
    setFindIndex(-1);
  }, []);
  const onFindToggle = useCallback(() => {
    if (findOpenRef.current) onFindClose();
    else setFindOpen(true);
  }, [onFindClose]);

  const moveFind = useCallback(
    (direction: 1 | -1) => {
      if (activeTab?.content?.kind === 'html') {
        const marks = findMarksRef.current;
        const index = cycleMatch(findIndexRef.current, marks.length, direction);
        if (index < 0) return;
        findIndexRef.current = index;
        setFindIndex(index);
        focusFindMatch(marks, index);
        return;
      }
      const index = cycleMatch(findIndexRef.current, textFindMatches.length, direction);
      if (index < 0) return;
      findIndexRef.current = index;
      setFindIndex(index);
    },
    [activeTab?.content?.kind, textFindMatches.length],
  );

  const onFindNext = useCallback(() => moveFind(1), [moveFind]);
  const onFindPrev = useCallback(() => moveFind(-1), [moveFind]);

  // Keep iframe highlights in step with the query and the active document.
  useEffect(() => {
    if (!findOpen) return;
    if (activeTab?.content?.kind === 'html') {
      runFindOnDoc(frameRef.current?.contentDocument ?? null, findQuery);
      return;
    }
    const index = textFindMatches.length > 0 ? 0 : -1;
    findIndexRef.current = index;
    setFindCount(textFindMatches.length);
    setFindIndex(index);
  }, [findOpen, findQuery, activeTab?.id, activeTab?.content?.body, activeTab?.content?.kind, textFindMatches.length, runFindOnDoc]);

  const onPreviewEmbedded = useCallback(
    async (document: EmbeddedDocument) => {
      setEmbeddedPreview({ document, loading: true });
      try {
        if (document.url.startsWith('data:')) {
          const decodedText = document.kind === 'text' ? textFromDataUrl(document.url) : '';
          setEmbeddedPreview(
            decodedText
              ? { document, loading: false, text: decodedText }
              : { document, loading: false, dataUrl: document.url },
          );
          return;
        }
        if (document.kind === 'media' && mediaStreamingAvailable()) {
          setEmbeddedPreview({ document, loading: false });
          return;
        }
        const res = await fetchSubresource(document.url, 'document');
        if (!res) throw new Error('Could not fetch this embedded document through the mixnet.');
        const contentType = res.contentType || document.contentType;
        if (document.kind === 'text' || contentType.startsWith('text/')) {
          const text = new TextDecoder().decode(res.bytes);
          setEmbeddedPreview({ document, loading: false, text: text.slice(0, 200_000) });
        } else {
          setEmbeddedPreview({ document, loading: false, dataUrl: dataUrlFor(res.bytes, contentType) });
        }
      } catch (err) {
        setEmbeddedPreview({
          document,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [fetchSubresource],
  );

  const onOpenEmbedded = useCallback(
    (document: EmbeddedDocument) => {
      setEmbeddedPreview(null);
      void goTo(document.url);
    },
    [goTo],
  );

  const onPrint = useCallback(() => {
    const content = activeTab?.content;
    if (!content || !activeTab) return;
    const title = tabTitle(activeTab);
    let opened = false;
    if (content.kind === 'html') opened = printDocument({ title, html: content.body });
    else if (content.kind === 'text' || content.kind === 'json') opened = printDocument({ title, text: content.body });
    else if (content.kind === 'image') opened = printDocument({ title, imageUrl: content.body });
    else opened = printDocument({ title, text: `${content.contentType}\n${activeTab.url}\n` });
    if (!opened) {
      append('print window blocked; opening the system print dialog for the app shell');
      window.print();
    }
  }, [activeTab, append]);

  const onPermissionChange = useCallback(
    (name: PermissionName, decision: PermissionDecision) => {
      const registry = permissionRegistryRef.current;
      if (!registry) return;
      registry.set(permissionScope, name, decision);
      savePermissions(defaultStorage(), registry);
      setPermissionVersion((value) => value + 1);
      append(`permission ${name}=${decision} for ${permissionScope}`);
    },
    [append, permissionScope],
  );

  const onPermissionReset = useCallback(() => {
    const registry = permissionRegistryRef.current;
    if (!registry) return;
    registry.clear(permissionScope);
    savePermissions(defaultStorage(), registry);
    setPermissionVersion((value) => value + 1);
    append(`permissions reset for ${permissionScope}`);
  }, [append, permissionScope]);

  // Browser keyboard shortcuts: find, zoom, escape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) {
        if (event.key === 'Escape' && findOpenRef.current) onFindClose();
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'f') {
        event.preventDefault();
        setFindOpen(true);
      } else if (key === '+' || key === '=') {
        event.preventDefault();
        applyZoom(nextZoom(zoom, 1));
      } else if (key === '-') {
        event.preventDefault();
        applyZoom(nextZoom(zoom, -1));
      } else if (key === '0') {
        event.preventDefault();
        applyZoom(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applyZoom, onFindClose, zoom]);

  /**
   * Attach link interception to the same-origin sandbox document. The document
   * has no scripts; `allow-same-origin` lets this parent handler turn a link
   * click into a tab navigation instead of letting the iframe navigate itself.
   */
  const onFrameLoad = useCallback(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc || linkedFrameDocsRef.current.has(doc)) return;
    linkedFrameDocsRef.current.add(doc);
    const activate = (event: Event) => {
      const target = event.target as Element | null;
      const anchor =
        target && typeof target.closest === 'function'
          ? target.closest('a[data-nysiris-href], area[data-nysiris-href]')
          : null;
      const href = anchor?.getAttribute('data-nysiris-href');
      if (!href) return;
      event.preventDefault();
      void goTo(href);
    };
    doc.addEventListener('click', activate);
    doc.addEventListener('auxclick', activate);

    const pageUrl = frame.getAttribute('data-page-url') ?? '';
    if (pageUrl) {
      const saved = loadScrollPositions(defaultStorage())[pageUrl] ?? 0;
      requestAnimationFrame(() => {
        try {
          frame.contentWindow?.scrollTo(0, saved);
        } catch {
          // Frame may have navigated/replaced itself.
        }
      });
      let timer = 0;
      frame.contentWindow?.addEventListener(
        'scroll',
        () => {
          window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            try {
              rememberScroll(defaultStorage(), pageUrl, frame.contentWindow?.scrollY ?? 0);
            } catch {
              // Storage unavailable; restore just won't persist.
            }
          }, 150);
        },
        { passive: true },
      );
    }
    if (findOpenRef.current) runFindOnDoc(doc, findQueryRef.current);
  }, [goTo, runFindOnDoc]);

  useEffect(() => {
    setEmbeddedPreview(null);
  }, [activeTabId, activeTab?.url]);

  useEffect(() => {
    const frame = frameRef.current;
    const url = activeTab?.url;
    if (!frame || !url || activeTab?.content?.kind !== 'html') return;
    const saved = loadScrollPositions(defaultStorage())[url] ?? 0;
    const id = requestAnimationFrame(() => {
      try {
        frame.contentWindow?.scrollTo(0, saved);
      } catch {
        // The document may not be ready yet; onFrameLoad restores again.
      }
    });
    return () => cancelAnimationFrame(id);
  }, [activeTabId, activeTab?.url, activeTab?.content?.body]);

  // Text/JSON pages scroll the app window rather than an iframe, so they need
  // their own per-URL restore/save path.
  useEffect(() => {
    const url = activeTab?.url;
    const kind = activeTab?.content?.kind;
    if (view !== 'portal' || !url || (kind !== 'text' && kind !== 'json')) return;
    const saved = loadScrollPositions(defaultStorage())[url] ?? 0;
    const id = requestAnimationFrame(() => window.scrollTo(0, saved));
    let timer = 0;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => rememberScroll(defaultStorage(), url, window.scrollY), 150);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(id);
      window.clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
    };
  }, [activeTabId, activeTab?.url, activeTab?.content?.body, activeTab?.content?.kind, view]);

  /** Re-fetch a tab's current URL without pushing a history entry. */
  const reloadTab = useCallback(
    async (tab: BrowserTab, historyIndex?: number) => {
      if (!tab.url) return;
      let target: NavigationTarget;
      try {
        target = resolveNavigationInput(tab.url);
      } catch (err) {
        setNavigationError(err instanceof Error ? err.message : String(err));
        return;
      }
      const { token, signal } = beginNavigation(tab.id);
      await loadInto(target, tab.id, { push: false, historyIndex, token, force: true, signal });
    },
    [beginNavigation, loadInto],
  );

  const onBack = useCallback(() => {
    if (!activeTab) return;
    const entry = historyEntry(activeTab, -1);
    if (!entry) return;
    let target: NavigationTarget;
    try {
      target = resolveNavigationInput(entry.url);
    } catch (err) {
      setNavigationError(err instanceof Error ? err.message : String(err));
      return;
    }
    const { token, signal } = beginNavigation(activeTab.id);
    void loadInto(target, activeTab.id, { push: false, historyIndex: entry.index, token, signal });
  }, [activeTab, beginNavigation, loadInto]);

  const onForward = useCallback(() => {
    if (!activeTab) return;
    const entry = historyEntry(activeTab, 1);
    if (!entry) return;
    let target: NavigationTarget;
    try {
      target = resolveNavigationInput(entry.url);
    } catch (err) {
      setNavigationError(err instanceof Error ? err.message : String(err));
      return;
    }
    const { token, signal } = beginNavigation(activeTab.id);
    void loadInto(target, activeTab.id, { push: false, historyIndex: entry.index, token, signal });
  }, [activeTab, beginNavigation, loadInto]);

  const onReload = useCallback(() => {
    if (!activeTab?.url) return;
    void reloadTab(activeTab);
  }, [activeTab, reloadTab]);

  const onStop = useCallback(() => {
    if (!activeTab) return;
    abortRef.current.get(activeTab.id)?.abort();
    abortRef.current.delete(activeTab.id);
    setAuthPrompt((prev) => (prev && prev.tabId === activeTab.id ? null : prev));
    setTabs((prev) => prev.map((tab) => (tab.id === activeTab.id ? stopPage(tab) : tab)));
    append('load stopped');
  }, [activeTab, append]);

  /**
   * Open a portal workspace in its own tab. Existing tabs for the same service
   * are selected (and their history preserved); otherwise a blank tab or a new
   * tab is used. Cross-portal links therefore do not destroy the current portal.
   */
  const openPortalWorkspace = useCallback(
    async (raw: string) => {
      if (!raw.trim()) return;
      let target: NavigationTarget;
      try {
        target = resolveNavigationInput(raw);
      } catch (err) {
        setNavigationError(err instanceof Error ? err.message : String(err));
        return;
      }
      const address = target.address;
      const existing = tabs.find(
        (tab) =>
          (target.kind === 'nym' && (tab.address === address || tab.service === address)) ||
          (target.kind === 'clearnet' && tab.address === address),
      );
      onSelectView('portal');

      if (existing) {
        setActiveTabId(existing.id);
        if (target.path !== '/' && existing.url !== target.url) {
          setUri(target.url);
          const { token, signal } = beginNavigation(existing.id);
          await loadInto(target, existing.id, { push: true, token, signal });
        } else {
          setUri(existing.url || target.url);
          if (existing.url && !existing.content && !existing.loading && !existing.error) {
            void reloadTab(existing);
          }
        }
        return;
      }

      const blank = tabs.find((tab) => !tab.url && !tab.loading);
      if (blank) {
        setActiveTabId(blank.id);
        setUri(target.url);
        const { token, signal } = beginNavigation(blank.id);
        await loadInto(target, blank.id, { push: true, token, signal });
        return;
      }

      const result = addBlankTab(tabs, newTabId);
      if (result.tabs.length === tabs.length) {
        // Tab limit reached: reuse the active tab rather than silently dropping
        // the navigation.
        void goTo(raw);
        return;
      }
      setTabs(result.tabs);
      setActiveTabId(result.tab.id);
      setUri(target.url);
      const { token, signal } = beginNavigation(result.tab.id);
      await loadInto(target, result.tab.id, { push: true, token, signal });
    },
    [activeTab, beginNavigation, goTo, loadInto, onSelectView, reloadTab, tabs],
  );

  const onSelectTab = useCallback(
    (id: string) => {
      const tab = tabs.find((candidate) => candidate.id === id);
      setActiveTabId(id);
      setNavigationError(null);
      onSelectView('portal');
      if (!tab) return;
      setUri(tab.url);
      // Restored tabs have no body yet: load the document on first selection.
      if (tab.url && !tab.content && !tab.loading && !tab.error) void reloadTab(tab);
    },
    [onSelectView, reloadTab, tabs],
  );

  const onNewTab = useCallback(() => {
    const result = addBlankTab(tabs, newTabId);
    const created = result.tabs.length > tabs.length;
    setTabs(result.tabs);
    setActiveTabId(result.tab.id);
    setUri(created ? '' : result.tab.url);
    setNavigationError(null);
    onSelectView('portal');
  }, [onSelectView, tabs]);

  const onCloseTab = useCallback(
    (id: string) => {
      abortRef.current.get(id)?.abort();
      abortRef.current.delete(id);
      setAuthPrompt((prev) => (prev && prev.tabId === id ? null : prev));
      const result = closeBrowserTab(tabs, id, activeTabId);
      setTabs(result.tabs);
      setActiveTabId(result.activeId);
      setUri(result.tabs.find((tab) => tab.id === result.activeId)?.url ?? '');
      setNavigationError(null);
    },
    [activeTabId, tabs],
  );

  const saveCurrentPage = useCallback(() => {
    if (!activeTab?.content || !activeTab.url) return;
    const contentType = activeTab.content.contentType;
    const meta = pageMetaRef.current.get(activeTab.url) ?? null;
    const name = downloadName(activeTab.title || tabTitle(activeTab), contentType, meta?.filename);
    const size = downloadDataUrl(activeTab.content.body, name);
    if (size === null) return;
    setDownloads((prev) =>
      addDownload(prev, {
        id: newDownloadId(),
        name,
        url: activeTab.url,
        contentType,
        size,
        status: 'saved',
        createdAt: Date.now(),
        received: size,
        total: meta?.total ?? size,
        etag: meta?.etag ?? null,
      }),
    );
  }, [activeTab]);

  /** HEAD metadata for a download: name, length, validator, range support. */
  const headTarget = useCallback(
    async (target: NavigationTarget): Promise<DownloadMeta | null> => {
      try {
        if (target.kind === 'nym') {
          const headers: Record<string, string> = { accept: '*/*' };
          const authorization = credentialsRef.current?.authorizationFor(target.address) ?? '';
          if (authorization) headers.authorization = authorization;
          const res = await fetchNym(
            target.address,
            { method: 'HEAD', path: target.path, headers },
            { timeoutMs: 30_000 },
          );
          if (res.error || res.status >= 400) return null;
          return metaFromHeaders(res.headers ?? {}, target.url);
        }
        const result = await requestClearnet(target.url, {
          method: 'HEAD',
          headers: { accept: '*/*', 'accept-encoding': 'identity' },
        });
        if (result.response.status >= 400) return null;
        return metaFromHeaders(headersToRecord(result.response.headers), result.url || target.url);
      } catch {
        return null;
      }
    },
    [requestClearnet],
  );

  /** One Range GET per loop iteration for the resumable downloader. */
  const rangeFetcherFor = useCallback(
    (target: NavigationTarget): RangeFetcher => {
      if (target.kind === 'nym') {
        return async (request, signal) => {
          const headers: Record<string, string> = { accept: '*/*', range: `bytes=${request.start}-` };
          if (request.start > 0 && request.etag) headers['if-range'] = request.etag;
          const authorization = credentialsRef.current?.authorizationFor(target.address) ?? '';
          if (authorization) headers.authorization = authorization;
          const res = await fetchNym(
            target.address,
            { method: 'GET', path: target.path, headers },
            { timeoutMs: 90_000, signal },
          );
          return { status: res.status, headers: res.headers ?? {}, body: res.body };
        };
      }
      return async (request, signal) => {
        // `identity` keeps Range offsets aligned with the bytes on the wire:
        // a compressed chunk cannot be decoded independently.
        const headers: Record<string, string> = {
          accept: '*/*',
          'accept-encoding': 'identity',
          range: `bytes=${request.start}-`,
        };
        if (request.start > 0 && request.etag) headers['if-range'] = request.etag;
        const result = await requestClearnet(target.url, { headers, signal });
        const record = headersToRecord(result.response.headers);
        const raw = new Uint8Array(await result.response.arrayBuffer());
        const body = await decodeContentEncoding(raw, headerValue(record, 'content-encoding'));
        return { status: result.response.status, headers: record, body };
      };
    },
    [requestClearnet],
  );

  const fetchRangeForUrl = useCallback(
    async (
      url: string,
      request: { start: number; end: number | null; etag: string | null },
      signal?: AbortSignal,
    ) => {
      const target = resolveNavigationInput(url);
      return rangeFetcherFor(target)(request, signal);
    },
    [rangeFetcherFor],
  );

  // Serve `/__nysiris-media/<token>` Range requests from the service worker.
  useEffect(() => startMediaBridge({ fetchRange: fetchRangeForUrl }), [fetchRangeForUrl]);

  const cacheMediaForUrl = useCallback(
    async (url: string, contentType: string, total: number | null) => {
      const target = resolveNavigationInput(url);
      await downloadMediaToCache(
        rangeFetcherFor(target),
        defaultMediaCache(),
        url,
        contentType,
        total,
      );
      append(`saved media for offline: ${url}`);
    },
    [append, rangeFetcherFor],
  );

  const saveDownloadAgain = useCallback(
    async (entry: DownloadRecord) => {
      if (activeDownloadsRef.current.has(entry.id)) return;
      activeDownloadsRef.current.add(entry.id);
      let target: NavigationTarget;
      try {
        target = resolveNavigationInput(entry.url);
      } catch (err) {
        activeDownloadsRef.current.delete(entry.id);
        setDownloads((prev) =>
          updateDownload(prev, entry.id, {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }

      setDownloads((prev) => updateDownload(prev, entry.id, { status: 'pending', error: undefined }));
      const head = await headTarget(target);
      const contentType = head?.contentType || entry.contentType;
      const serverName = head?.filename ?? null;
      const name = serverName
        ? downloadName(serverName, contentType, serverName)
        : entry.name || downloadName('download', contentType);
      const total = head?.total ?? entry.total ?? null;
      const etag = head?.etag ?? entry.etag ?? null;

      // Resume only when the retained bytes belong to the same validator.
      const previous = downloadPartsRef.current.get(entry.id);
      const canResume = entry.status === 'partial' || entry.status === 'failed';
      const keepPrevious = Boolean(previous && previous.length > 0 && (!entry.etag || !etag || entry.etag === etag));
      const initial = canResume && keepPrevious && previous ? previous : new Uint8Array(0);

      setDownloads((prev) =>
        updateDownload(prev, entry.id, { name, contentType, total, etag, received: initial.length, size: initial.length }),
      );

      try {
        const result = await transferRanges(rangeFetcherFor(target), {
          initial,
          total,
          etag,
          maxBytes: 32 * 1024 * 1024,
          onProgress: (received, progressTotal) => {
            setDownloads((prev) =>
              updateDownload(prev, entry.id, {
                status: 'pending',
                received,
                total: progressTotal,
                size: received,
              }),
            );
          },
        });
        saveBlob(result.bytes, contentType || entry.contentType, name);
        downloadPartsRef.current.delete(entry.id);
        setDownloads((prev) =>
          updateDownload(prev, entry.id, {
            status: 'saved',
            name,
            size: result.received,
            contentType: contentType || entry.contentType,
            received: result.received,
            total: result.total,
            etag: result.etag,
            error: undefined,
          }),
        );
        append(`download saved: ${name} (${formatSize(result.received)})`);
      } catch (err) {
        const transfer = err instanceof TransferError ? err : null;
        const partial = transfer?.bytes ?? initial;
        if (partial.length > 0) retainPartialDownload(downloadPartsRef.current, entry.id, partial);
        const aborted = isAbortError(err);
        const message = aborted
          ? 'Download paused — resume to continue.'
          : err instanceof Error
            ? err.message
            : String(err);
        setDownloads((prev) =>
          updateDownload(prev, entry.id, {
            status: partial.length > 0 ? 'partial' : 'failed',
            size: partial.length,
            received: partial.length,
            total: transfer?.total ?? total,
            etag: transfer?.etag ?? etag,
            error: message,
          }),
        );
        append(`download ${aborted ? 'paused' : 'failed'}: ${message}`);
      } finally {
        activeDownloadsRef.current.delete(entry.id);
      }
    },
    [append, headTarget, rangeFetcherFor],
  );

  const onAuthSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const prompt = authPrompt;
      if (!prompt || !isSupportedChallenge(prompt.challenge)) return;
      credentialsRef.current?.set(prompt.scope, prompt.challenge.realm, authUser, authPass);
      setAuthPrompt(null);
      setAuthError('');
      const { token, signal } = beginNavigation(prompt.tabId);
      append(`signing in to ${prompt.scope}`);
      void loadInto(prompt.target, prompt.tabId, { push: false, token, force: true, signal });
    },
    [append, authPass, authPrompt, authUser, beginNavigation, loadInto],
  );

  const onAuthCancel = useCallback(() => {
    setAuthPrompt(null);
    setAuthError('');
    setAuthUser('');
    setAuthPass('');
    append('sign-in cancelled');
  }, [append]);

  const onOpenDownloads = useCallback(() => {
    setAdvanced(true);
    saveAdvancedVisible(true, defaultViewStorage());
    setOpenPanels((prev) => {
      if (prev.includes('downloads')) return prev;
      const next = [...prev, 'downloads' as const];
      saveOpenPanels(next, defaultStorage());
      return next;
    });
    onSelectView('settings');
  }, [onSelectView]);

  // Persist the tab list and histories. Page bodies never go to storage.
  useEffect(() => {
    saveBrowserTabs(defaultStorage(), tabs, activeTabId);
  }, [tabs, activeTabId]);

  useEffect(() => {
    saveDownloads(defaultStorage(), downloads);
  }, [downloads]);

  // On first mount, restore and load the active tab once (page bodies are not
  // persisted). An OS launch link wins over the restored document; tabs and
  // history are still restored underneath it.
  useEffect(() => {
    if (bootRestoredRef.current) return;
    bootRestoredRef.current = true;
    if (initialDeepLink) {
      onSelectView('portal');
      void goTo(initialDeepLink);
      return;
    }
    const tab = tabs.find((candidate) => candidate.id === activeTabId);
    if (tab?.url && !tab.content && !tab.loading) void reloadTab(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  // Links delivered while the app is running (Electron postMessage, Android
  // appUrlOpen, hash changes). The ref avoids re-subscribing on every render.
  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  useEffect(
    () =>
      subscribeDeepLinks((link) => {
        append(`opening OS link ${link.slice(0, 96)}`);
        onSelectView('portal');
        void goToRef.current(link);
      }),
    [append, onSelectView],
  );

  // After an in-place reconnect, reload the visible document so it reflects the
  // new tunnel. Other tabs keep their URLs/history and load on selection.
  useEffect(() => {
    if (reconnectEpoch === 0) return;
    const tab = tabs.find((candidate) => candidate.id === activeTabId);
    if (tab?.url) void reloadTab(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect only
  }, [reconnectEpoch]);

  // "Run a Portal" tab: probe a running provider's address through the tunnel.
  const onProbePortal = useCallback(
    async (address: string): Promise<{ ok: boolean; summary: string }> => {
      append(`probe ${address.slice(0, 12)}…`);
      try {
        const res = await fetchNym(address, { method: 'GET', path: '/' }, { timeoutMs: 120_000 });
        const text = new TextDecoder().decode(res.body);
        return {
          ok: !res.error && res.status >= 200 && res.status < 500,
          summary: `status=${res.status}${res.error ? ` error=${res.error}` : ''} ${text.slice(0, 200)}`.trim(),
        };
      } catch (err) {
        append(`probe failed: ${String(err)}`);
        return { ok: false, summary: String(err) };
      }
    },
    [append],
  );

  const onVisitContact = useCallback(
    (address: string) => {
      setUri(address);
      void openPortalWorkspace(address);
      onSelectView('portal');
    },
    [onSelectView, openPortalWorkspace],
  );

  const onRemoveContact = useCallback(
    (name: string) => {
      setContacts((prev) => {
        const next = prev.filter((c) => c.name !== name);
        saveContacts(next, defaultContactStorage());
        return next;
      });
      append(`contact removed: ${name}`);
    },
    [append],
  );

  const onAcceptInvite = useCallback(() => {
    if (!pendingInvite || !petname.trim()) return;
    // Verify the signature before saving: an invite is only as good as its proof.
    if (!verifyInvite(pendingInvite.invite, pendingInvite.address)) {
      setLastError(new Error('invite signature invalid — not saved'));
      append('invite signature invalid — not saved');
      return;
    }
    setContacts((prev) => {
      const next = addContact(prev, {
        name: petname,
        address: pendingInvite.address,
        inviter: pendingInvite.inviter,
        note: pendingInvite.note,
      });
      if (next.length === prev.length) {
        append(`contact ${petname.trim().toLowerCase()} already saved`);
        return prev;
      }
      saveContacts(next, defaultContactStorage());
      return next;
    });
    append(`contact saved: ${petname.trim()}`);
    setPendingInvite(null);
    setPetname('');
  }, [pendingInvite, petname, append]);

  // Toolbar-controlled panels (Advanced). Closed panels only hide their view —
  // background work (tunnel, inbox, polling) keeps running. Persisted.
  const [openPanels, setOpenPanels] = useState<PanelId[]>(() => loadOpenPanels(defaultStorage()));

  const onTogglePanel = useCallback((id: PanelId) => {
    setOpenPanels((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
      saveOpenPanels(next, defaultStorage());
      return next;
    });
  }, []);

  const onClosePanel = useCallback((id: PanelId) => {
    setOpenPanels((prev) => {
      const next = prev.filter((p) => p !== id);
      saveOpenPanels(next, defaultStorage());
      return next;
    });
  }, []);

  const { label, tone } = describeStatus(status);

  // Messages: group the inbox into threads by sender; contacts start new ones.
  const threads = useMemo(() => buildInboxThreads(inbox, contacts), [inbox, contacts]);

  const activeMessages = useMemo(() => {
    if (!activeThread) return [];
    if (isContactThread(activeThread)) return [];
    return inbox.filter((m, i) => threadKeyFor(m, i) === activeThread);
  }, [inbox, activeThread]);

  // Inbox size per thread for the roster's unread badges.
  const threadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    inbox.forEach((m, i) => {
      const key = threadKeyFor(m, i);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  }, [inbox]);

  // Opening a thread (or receiving into the open one) marks it read.
  useEffect(() => {
    if (!activeThread) return;
    const seen = threadCounts.get(activeThread) ?? 0;
    setReadCounts((prev) => (prev[activeThread] === seen ? prev : { ...prev, [activeThread]: seen }));
  }, [activeThread, threadCounts]);

  // Desktop roster rows, derived from the same state as the main views.
  // Favourites pin above recents; the open portal is always visible even if
  // it was never starred or visited before this session.
  const rosterPortals = useMemo(() => {
    const seen = new Set<string>();
    const rows: RosterPortal[] = [];
    const push = (address: string, starred: boolean) => {
      const clean = address.trim();
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      rows.push({
        address: clean,
        current: clean === socialService,
        active: clean === socialService && view === 'portal',
        starred,
      });
    };
    for (const address of favorites) push(address, true);
    for (const address of recentPortals) push(address, false);
    if (socialService) push(socialService, isFavoritePortal(favorites, socialService));
    return rows;
  }, [favorites, recentPortals, socialService, view]);

  // Star/unstar the bound portal. Persisted; the roster re-sorts on its own.
  const onToggleFavorite = useCallback(
    (address: string) => {
      const adding = !isFavoritePortal(favorites, address);
      setFavorites((prev) => {
        const next = toggleFavoritePortal(prev, address);
        saveFavoritePortals(next, defaultViewStorage());
        return next;
      });
      append(adding ? 'portal added to favourites' : 'portal removed from favourites');
    },
    [favorites, append],
  );

  const currentFavorite = socialService ? isFavoritePortal(favorites, socialService) : false;

  const displayedText =
    activeTab?.content && (activeTab.content.kind === 'text' || activeTab.content.kind === 'json')
      ? activeTab.content.body.slice(0, 200_000)
      : '';
  const textFindSegments = useMemo(
    () =>
      findOpen && findQuery
        ? highlightSegments(displayedText, textFindMatches)
        : [{ text: displayedText, match: false }],
    [displayedText, findOpen, findQuery, textFindMatches],
  );

  // The link a bookmark saves: the last opened private link (keeps any path),
  // otherwise the bound portal address.
  const bookmarkLink = uri.trim() || socialService;
  const currentBookmarked = isBookmarked(bookmarks, bookmarkLink);

  const onAddBookmark = useCallback(() => {
    const name = bookmarkName.trim();
    if (!name || !bookmarkLink) return;
    const next = addBookmark(bookmarks, { name, link: bookmarkLink });
    if (next.length === bookmarks.length) {
      append(`a bookmark named “${name}” already exists`);
      return;
    }
    setBookmarks(next);
    saveBookmarks(next, defaultBookmarkStorage());
    setBookmarkName('');
    setShowBookmarkField(false);
    append(`bookmark saved: ${name}`);
  }, [bookmarkName, bookmarkLink, bookmarks, append]);

  const onRemoveBookmark = useCallback(
    (name: string) => {
      const next = removeBookmark(bookmarks, name);
      setBookmarks(next);
      saveBookmarks(next, defaultBookmarkStorage());
      append(`bookmark removed: ${name}`);
    },
    [bookmarks, append],
  );

  // Open a saved link/favourite: same flow as the URI bar, then show the Portal.
  const onOpenSaved = useCallback(
    (link: string) => {
      setUri(link);
      void goTo(link);
      onSelectView('portal');
    },
    [goTo, onSelectView],
  );

  const rosterThreads = useMemo(
    () =>
      threads.map((key) => {
        const total = threadCounts.get(key) ?? 0;
        return {
          key,
          label: threadLabel(key, contacts),
          active: key === activeThread,
          unread: threadUnread(total, readCounts[key] ?? 0),
        };
      }),
    [threads, threadCounts, contacts, activeThread, readCounts],
  );

  const activeThreadAddress = useMemo(() => {
    if (!activeThread) return null;
    if (isContactThread(activeThread)) return contactAddressOf(activeThread);
    return null;
  }, [activeThread]);

  const onboardingStep = !onboarded
    ? status.state === 'ready'
      ? 'done'
      : status.state === 'connecting'
        ? 'connecting'
        : 'welcome'
    : 'done';

  const statusDetail = lastError ? friendlyError(lastError).technical : undefined;

  return (
    <div className="fly-shell">
      <TopBar
        view={view}
        onSelectView={onSelectView}
        status={status}
        statusDetail={statusDetail}
        onRetry={onConnect}
        busy={busy}
        advanced={advanced}
        onToggleAdvanced={onToggleAdvanced}
        contextOpen={contextOpen}
        onToggleContext={onToggleContext}
      />
      <BrowserChrome
        tabs={tabs}
        activeTabId={activeTabId}
        canBack={canGoBack(activeTab)}
        canForward={canGoForward(activeTab)}
        loading={Boolean(activeTab?.loading)}
        error={navigationError}
        downloadCount={downloads.length}
        onOpenDownloads={onOpenDownloads}
        uri={uri}
        onUriChange={onAddressChange}
        onSubmit={onGo}
        onBack={onBack}
        onForward={onForward}
        onReload={onReload}
        onStop={onStop}
        onNewTab={onNewTab}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
      />
      <BrowserTools
        zoom={zoom}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onZoomReset={onZoomReset}
        findOpen={findOpen}
        findQuery={findQuery}
        findCount={findCount}
        findIndex={findIndex}
        onFindToggle={onFindToggle}
        onFindQuery={onFindQuery}
        onFindNext={onFindNext}
        onFindPrev={onFindPrev}
        onFindClose={onFindClose}
        onPrint={onPrint}
        printDisabled={!activeTab?.content}
        permissionsOpen={permissionsOpen}
        onPermissionsToggle={() => {
          setPermissionsOpen((open) => !open);
          onSelectView('portal');
        }}
        offline={!online}
        swControlled={swControlled}
      />
      {!online && (
        <p className="fly-callout-warn fly-offline-note" role="status">
          Offline — the cached app shell is available, but new mixnet pages cannot load until the network returns.
        </p>
      )}
      <div className="fly-desktop" data-context={contextOpen ? 'open' : 'closed'}>
        <Roster
          portals={rosterPortals}
          contacts={contacts}
          threads={rosterThreads}
          selfAddress={selfAddress}
          onOpenPortal={onVisitContact}
          onOpenContact={onVisitContact}
          onSelectThread={onSelectThread}
        />
        <div className="fly-main">
          <header className="fly-classic-header">
            <h1 className="fly-h1">Nysiris</h1>
            <p className="fly-muted">Browse and chat over the private network.</p>
          </header>

          <AppNav
            active={view}
            onSelect={onSelectView}
            status={status}
            statusDetail={statusDetail}
            onRetry={onConnect}
            busy={busy}
          />

          {lastError !== null && lastError !== undefined && view !== 'settings' && (
            <FriendlyError error={lastError} onRetry={onConnect} retrying={busy} />
          )}

          {view === 'home' && (
            <main>
              {!onboarded && onboardingStep !== 'done' && (
                <Onboarding
                  step={onboardingStep}
                  busy={busy}
                  error={lastError}
                  onConnect={() => void onConnect()}
                  onDismiss={onDismissOnboarding}
                />
              )}
              {!onboarded && onboardingStep === 'done' && (
                <section className="fly-card" aria-label="You're protected">
                  <h2>You are protected ✓</h2>
                  <p>Your traffic is travelling the private network. Open a private link or say hello.</p>
                  <div className="fly-row">
                    <button
                      className="fly-btn fly-btn-primary"
                      onClick={() => {
                        onDismissOnboarding();
                        onSelectView('portal');
                      }}
                    >
                      Get started
                    </button>
                  </div>
                </section>
              )}

              {/* Persistent status card: only after onboarding is dismissed —
                  before that the Onboarding box is the single home status. */}
              {onboarded && (
                <section className="fly-card" aria-label="Protection status">
                  <h2>
                    {spent
                      ? 'Disconnected'
                      : status.state === 'ready'
                        ? 'You are protected'
                        : status.state === 'connecting'
                          ? 'Connecting…'
                          : 'Not protected yet'}
                  </h2>
                  <p>
                    {spent
                      ? 'The tunnel was switched off. Reconnect to build a fresh private path.'
                      : status.state === 'ready'
                        ? 'Your connection is running over the private network.'
                        : status.state === 'connecting'
                          ? 'Finding the fastest private path. This usually takes a few seconds.'
                          : 'Connect once — we handle the private path for you.'}
                  </p>
                  <div className="fly-row">
                    {spent ? (
                      <button className="fly-btn fly-btn-primary" onClick={() => void onReconnect()} disabled={busy}>
                        Reconnect
                      </button>
                    ) : (
                      status.state !== 'ready' && (
                        <button className="fly-btn fly-btn-primary" onClick={() => void onConnect()} disabled={busy}>
                          Connect privately
                        </button>
                      )
                    )}
                    {status.state === 'ready' && (
                      <>
                        <button className="fly-btn" onClick={() => void onProveTunnel()} disabled={busy}>
                          Prove I am protected
                        </button>
                        <button className="fly-btn" onClick={() => void onDisconnect()} disabled={busy}>
                          Switch off
                        </button>
                      </>
                    )}
                  </div>
                  {exit.recommendReconnect && (
                    <p className="fly-callout-warn fly-mt-2" role="note">
                      Exit reuse limit reached ({exit.requests} requests on one exit). Reconnect to rotate your exit
                      (§5.2.2) — a fixed exit is a linking key at the destinations you visit.
                      <span className="fly-row fly-mt-2">
                        <button className="fly-btn" onClick={() => void onReconnect()} disabled={busy}>
                          Reconnect now
                        </button>
                      </span>
                    </p>
                  )}
                  {(clearnetIp || mixnetIp) && (
                    <p className="fly-muted">
                      {clearnetIp && mixnetIp
                        ? clearnetIp !== mixnetIp
                          ? 'Checked: your private address differs from your everyday one. ✓'
                          : 'Checked: the addresses look the same — try again in a moment.'
                        : 'Check in progress…'}
                    </p>
                  )}
                </section>
              )}

              <section
                className="fly-card"
                aria-label="Open a private link"
                style={activeTab?.url ? { display: 'none' } : undefined}
              >
                <h2>Open a private link</h2>
                <p>Paste a link someone shared with you. It opens privately on this device.</p>
                <div className="fly-row">
                  <input
                    className="fly-input"
                    placeholder="Paste a private link, then press Enter"
                    value={uri}
                    onChange={(e) => onAddressChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void onGo();
                    }}
                    spellCheck={false}
                    aria-label="Private link"
                  />
                  <button className="fly-btn fly-btn-primary" onClick={onGo} disabled={busy || !uri}>
                    Open
                  </button>
                  <QrScanButton
                    onScanText={(text) => setUri(text)}
                    onScanError={(message) => append(`qr scan: ${message}`)}
                  />
                </div>
              </section>

              {contacts.length > 0 && (
                <section className="fly-card" aria-label="Recent people and places">
                  <h2>People and places</h2>
                  <ul className="fly-conv-list">
                    {contacts.slice(0, 5).map((c) => (
                      <li key={c.name}>
                        <button onClick={() => onVisitContact(c.address)}>
                          <strong>{c.name}</strong> <span className="fly-muted">{shortenAddress(c.address)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="fly-row fly-mt-2">
                    <button className="fly-btn" onClick={() => onSelectView('messages')}>
                      Go to Messages
                    </button>
                    <button className="fly-btn" onClick={() => onSelectView('portal')}>
                      Go to Portal
                    </button>
                  </div>
                </section>
              )}
            </main>
          )}

          {view === 'messages' && (
            <main>
              <section className="fly-card" aria-label="Private messages">
                <h2>Messages</h2>
                <p>Private conversations. Names are petnames you chose — long addresses stay hidden.</p>
                {!selfAddress ? (
                  <div className="fly-row">
                    <button className="fly-btn fly-btn-primary" onClick={() => void onStartMessaging()} disabled={busy}>
                      Turn on private messages
                    </button>
                  </div>
                ) : (
                  <div className="fly-chat">
                    <div>
                      <h3 className="fly-h3">Chats</h3>
                      {threads.length === 0 && (
                        <p className="fly-muted">No chats yet. Add someone below to say hello.</p>
                      )}
                      <ul className="fly-conv-list">
                        {threads.map((key) => (
                          <li key={key}>
                            <button
                              aria-current={activeThread === key}
                              onClick={() => {
                                setActiveThread(key);
                                if (isContactThread(key)) {
                                  setRecipient(contactAddressOf(key));
                                }
                              }}
                            >
                              {threadLabel(key, contacts)}
                            </button>
                          </li>
                        ))}
                      </ul>
                      <div className="fly-mt-3">
                        <label className="fly-muted" htmlFor="msg-to">
                          Message someone new (paste their private address once, then use their name)
                        </label>
                        <input
                          id="msg-to"
                          className="fly-input"
                          placeholder="Their private address"
                          value={recipient}
                          onChange={(e) => setRecipient(e.target.value)}
                          spellCheck={false}
                        />
                      </div>
                    </div>
                    <div>
                      <h3 className="fly-h3">{activeThread ? threadLabel(activeThread, contacts) : 'Conversation'}</h3>
                      {!activeThread && <p className="fly-muted">Pick a chat, or paste an address to start one.</p>}
                      <ul className="fly-plain-list">
                        {activeMessages.map((m, i) => (
                          <li key={i} className="fly-preview-msg">
                            <span className="fly-break-word">{m.text}</span>{' '}
                            {m.senderTag && (
                              <button className="fly-btn fly-btn-sm fly-mt-1" onClick={() => void onReply(m)}>
                                Reply
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                      <div className="fly-row">
                        <input
                          className="fly-input"
                          placeholder="Write a message"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          aria-label="Message"
                        />
                        <button
                          className="fly-btn fly-btn-primary"
                          onClick={() => void onSend()}
                          disabled={!recipient || !draft}
                        >
                          Send
                        </button>
                      </div>
                      <p className="fly-muted">
                        Replies are anonymous one-time tickets — the other side never sees your address.
                      </p>
                    </div>
                  </div>
                )}
              </section>

              {selfAddress && <ShareCard address={selfAddress} petname={null} linkLabel="My private link" />}
            </main>
          )}

          {view === 'portal' && (
            <main>
              <div className="fly-view-head">
                <h2>Portal</h2>
                <span className="fly-meta">A private site or community over the mixnet.</span>
              </div>
              <section
                className="fly-card"
                aria-label="Open a private link"
                style={activeTab?.url ? { display: 'none' } : undefined}
              >
                <p>Open a private site or community. The address bar below is bound to what you see.</p>
                <div className="fly-row">
                  <input
                    className="fly-input"
                    placeholder="Paste a private link, then press Enter"
                    value={uri}
                    onChange={(e) => onAddressChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void onGo();
                    }}
                    spellCheck={false}
                    aria-label="Private link"
                  />
                  <button className="fly-btn fly-btn-primary" onClick={onGo} disabled={busy || !uri}>
                    Open
                  </button>
                  <QrScanButton
                    onScanText={(text) => setUri(text)}
                    onScanError={(message) => append(`qr scan: ${message}`)}
                  />
                </div>
              </section>

              {socialService && (
                <>
                  <div className="fly-portal-bar" aria-label="Current portal">
                    <span className="fly-muted fly-break-all">{shortenAddress(socialService)}</span>
                    <button
                      className={currentFavorite ? 'fly-btn fly-btn-secondary' : 'fly-btn'}
                      aria-pressed={currentFavorite}
                      onClick={() => onToggleFavorite(socialService)}
                      title="Favourite this portal — pinned to the top of the roster"
                    >
                      <StarIcon size={13} /> {currentFavorite ? 'Favourited' : 'Favourite'}
                    </button>
                    <button
                      className={currentBookmarked ? 'fly-btn fly-btn-secondary' : 'fly-btn'}
                      aria-pressed={currentBookmarked}
                      onClick={() => {
                        setBookmarkName('');
                        setShowBookmarkField((open) => !open);
                      }}
                      title="Save this link with a name only you see"
                    >
                      <BookmarkIcon size={13} /> {currentBookmarked ? 'Bookmarked' : 'Bookmark'}
                    </button>
                  </div>
                  {showBookmarkField && (
                    <div className="fly-row" aria-label="Name this bookmark">
                      <input
                        className="fly-input"
                        placeholder="Name this bookmark (only you see it)"
                        value={bookmarkName}
                        onChange={(e) => setBookmarkName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') onAddBookmark();
                        }}
                        spellCheck={false}
                        aria-label="Bookmark name"
                      />
                      <button
                        className="fly-btn fly-btn-primary"
                        onClick={onAddBookmark}
                        disabled={!bookmarkName.trim()}
                      >
                        Save bookmark
                      </button>
                    </div>
                  )}
                </>
              )}

              <SavedLinks
                bookmarks={bookmarks}
                favorites={favorites}
                onOpen={onOpenSaved}
                onRemoveBookmark={onRemoveBookmark}
                onRemoveFavorite={onToggleFavorite}
              />

              {pendingInvite && (
                <section className="fly-card" aria-label="You've been invited">
                  <h2>You have been invited ✓</h2>
                  <p>
                    <strong>{shortenAddress(pendingInvite.inviter)}</strong> invited you
                    {pendingInvite.note ? <> — “{pendingInvite.note}”</> : ''}. Save them with a name you will remember.
                  </p>
                  <div className="fly-row">
                    <input
                      className="fly-input"
                      placeholder="Save as… (a name only you see)"
                      value={petname}
                      onChange={(e) => setPetname(e.target.value)}
                      spellCheck={false}
                      aria-label="Save invite as"
                    />
                    <button className="fly-btn fly-btn-primary" onClick={onAcceptInvite} disabled={!petname.trim()}>
                      Save
                    </button>
                    <button className="fly-btn" onClick={() => setPendingInvite(null)}>
                      Dismiss
                    </button>
                  </div>
                </section>
              )}

              {activeTab?.error && (
                <section className="fly-card" role="alert" aria-label="Page error">
                  <h2 className="fly-h2-flush">This page didn’t load</h2>
                  <p className="fly-muted fly-break-word">{activeTab.error}</p>
                  {activeTab.url && (
                    <button className="fly-btn" onClick={() => void reloadTab(activeTab)}>
                      Try again
                    </button>
                  )}
                </section>
              )}

              {authPrompt && authPrompt.tabId === activeTab?.id && (
                <section className="fly-card" role="region" aria-label="Sign in to this site">
                  <h2 className="fly-h2-flush">Sign in required</h2>
                  <p className="fly-muted fly-break-word">
                    {authPrompt.scope} asked for {authPrompt.challenge.label} authentication
                    {authPrompt.challenge.realm ? ` (realm “${authPrompt.challenge.realm}”)` : ''}. Credentials are kept
                    in memory for this session only.
                  </p>
                  {!isSupportedChallenge(authPrompt.challenge) && (
                    <p className="fly-callout-warn" role="note">
                      This site requested {authPrompt.challenge.label} authentication. This build supports Basic
                      authentication only.
                    </p>
                  )}
                  <form className="fly-row" onSubmit={onAuthSubmit} aria-label="Credentials">
                    <input
                      className="fly-input"
                      placeholder="Username"
                      value={authUser}
                      onChange={(event) => setAuthUser(event.target.value)}
                      autoComplete="username"
                      spellCheck={false}
                      aria-label="Username"
                    />
                    <input
                      className="fly-input"
                      type="password"
                      placeholder="Password"
                      value={authPass}
                      onChange={(event) => setAuthPass(event.target.value)}
                      autoComplete="current-password"
                      aria-label="Password"
                    />
                    <button
                      className="fly-btn fly-btn-primary"
                      type="submit"
                      disabled={!isSupportedChallenge(authPrompt.challenge) || (!authUser && !authPass)}
                    >
                      Sign in
                    </button>
                    <button className="fly-btn" type="button" onClick={onAuthCancel}>
                      Cancel
                    </button>
                  </form>
                  {authError && (
                    <p className="fly-callout-warn" role="alert">
                      {authError}
                    </p>
                  )}
                </section>
              )}

              {permissionsOpen && permissionRegistryRef.current && (
                <PermissionsPanel
                  scope={permissionScope}
                  registry={permissionRegistryRef.current}
                  onChange={onPermissionChange}
                  onReset={onPermissionReset}
                  onClose={() => setPermissionsOpen(false)}
                />
              )}

              {/* Same-origin lets this parent intercept links; scripts, forms,
                  popups, and top-navigation remain blocked by the sandbox, and
                  the loader strips active content before rendering. */}
              {activeTab?.content?.kind === 'html' && (
                <iframe
                  ref={frameRef}
                  id="fly-page"
                  className="fly-portal-frame"
                  sandbox="allow-same-origin"
                  referrerPolicy="no-referrer"
                  title={tabTitle(activeTab)}
                  data-page-url={activeTab.url}
                  srcDoc={activeTab.content.body}
                  loading="lazy"
                  onLoad={onFrameLoad}
                  style={{ zoom } as CSSProperties}
                />
              )}

              {(activeTab?.content?.kind === 'text' || activeTab?.content?.kind === 'json') && (
                <pre className="fly-pre fly-portal-text" aria-label="Page content" style={{ zoom } as CSSProperties}>
                  {textFindSegments.map((segment, index) =>
                    segment.match ? (
                      <mark
                        key={index}
                        className={
                          segment.index === findIndex ? 'fly-find-hit fly-find-current' : 'fly-find-hit'
                        }
                      >
                        {segment.text}
                      </mark>
                    ) : (
                      <span key={index}>{segment.text}</span>
                    ),
                  )}
                </pre>
              )}

              {activeTab?.content?.kind === 'image' && (
                <img
                  className="fly-portal-image"
                  src={activeTab.content.body}
                  alt={tabTitle(activeTab)}
                  style={{ zoom } as CSSProperties}
                />
              )}

              {activeTab?.content?.kind === 'media' && (
                <MediaView
                  url={activeTab.content.mediaUrl ?? activeTab.url}
                  contentType={activeTab.content.contentType}
                  dataUrl={activeTab.content.body || null}
                  total={activeTab.content.mediaTotal ?? null}
                  etag={activeTab.content.mediaEtag ?? null}
                  title={tabTitle(activeTab)}
                  zoom={zoom}
                  onSaveOffline={() =>
                    cacheMediaForUrl(
                      activeTab.content?.mediaUrl ?? activeTab.url,
                      activeTab.content?.contentType ?? 'application/octet-stream',
                      activeTab.content?.mediaTotal ?? null,
                    )
                  }
                />
              )}

              {activeTab?.content?.kind === 'pdf' && (
                <PdfView
                  dataUrl={activeTab.content.body}
                  title={tabTitle(activeTab)}
                  url={activeTab.content.mediaUrl ?? null}
                  total={activeTab.content.mediaTotal ?? null}
                  etag={activeTab.content.mediaEtag ?? null}
                  onSaveOffline={
                    activeTab.content.mediaUrl
                      ? () =>
                          cacheMediaForUrl(
                            activeTab.content?.mediaUrl ?? activeTab.url,
                            'application/pdf',
                            activeTab.content?.mediaTotal ?? null,
                          )
                      : undefined
                  }
                />
              )}

              {activeTab?.content?.kind === 'binary' && (
                <section className="fly-card" aria-label="Download">
                  <p className="fly-muted">
                    {activeTab.content.contentType || 'Binary content'} — this build does not render this file type.
                  </p>
                </section>
              )}

              {activeTab?.content?.kind === 'html' && (
                <EmbeddedDocuments
                  documents={activeTab.content.embedded ?? []}
                  onPreview={(document) => void onPreviewEmbedded(document)}
                  onOpen={onOpenEmbedded}
                />
              )}

              {embeddedPreview && (
                <section className="fly-card fly-embedded-preview" aria-label="Embedded document preview">
                  <div className="fly-row fly-row-between">
                    <h2 className="fly-h2-flush fly-break-word">{embeddedPreview.document.filename}</h2>
                    <button
                      type="button"
                      className="fly-btn fly-btn-sm"
                      onClick={() => setEmbeddedPreview(null)}
                      aria-label="Close embedded document"
                    >
                      Close
                    </button>
                  </div>
                  {embeddedPreview.loading && <p className="fly-muted">Fetching through the mixnet…</p>}
                  {embeddedPreview.error && (
                    <p className="fly-callout-warn" role="alert">
                      {embeddedPreview.error}
                    </p>
                  )}
                  {embeddedPreview.text !== undefined && (
                    <pre className="fly-pre fly-mt-2">{embeddedPreview.text}</pre>
                  )}
                  {embeddedPreview.dataUrl &&
                    (embeddedPreview.document.kind === 'pdf' ? (
                      <PdfView dataUrl={embeddedPreview.dataUrl} title={embeddedPreview.document.filename} />
                    ) : embeddedPreview.document.kind === 'image' ? (
                      <img
                        className="fly-portal-image"
                        src={embeddedPreview.dataUrl}
                        alt={embeddedPreview.document.filename}
                      />
                    ) : (
                      <p className="fly-muted">This document type can be opened in a tab or downloaded.</p>
                    ))}
                  {!embeddedPreview.dataUrl &&
                    !embeddedPreview.text &&
                    !embeddedPreview.error &&
                    embeddedPreview.document.kind === 'media' && (
                      <MediaView
                        url={embeddedPreview.document.url}
                        contentType={embeddedPreview.document.contentType}
                        dataUrl={null}
                        total={null}
                        etag={null}
                        title={embeddedPreview.document.filename}
                        onSaveOffline={() =>
                          cacheMediaForUrl(
                            embeddedPreview.document.url,
                            embeddedPreview.document.contentType,
                            null,
                          )
                        }
                      />
                    )}
                </section>
              )}

              {activeTab?.content &&
                ['image', 'media', 'pdf', 'binary'].includes(activeTab.content.kind) &&
                Boolean(activeTab.content.body) && (
                  <div className="fly-row fly-mt-2">
                    <button className="fly-btn fly-btn-primary" onClick={saveCurrentPage}>
                      Save to downloads
                    </button>
                  </div>
                )}

              {activeTab?.loading && (
                <p className="fly-muted" role="status">
                  Loading {activeTab.kind === 'clearnet' ? 'web page' : 'portal'}…
                </p>
              )}

              {activeTab?.url &&
                !activeTab.content &&
                !activeTab.loading &&
                !activeTab.error &&
                !(authPrompt && authPrompt.tabId === activeTab.id) && (
                  <section className="fly-card" aria-label="Restored tab">
                    <p className="fly-muted">This tab was restored. Load it when you’re ready.</p>
                    <button className="fly-btn fly-btn-primary" onClick={() => void reloadTab(activeTab)}>
                      Load {activeTab.kind === 'nym' ? shortenAddress(activeTab.address) : activeTab.address}
                    </button>
                  </section>
                )}

              {socialService && (
                <PortalWorkspace
                  key={socialService}
                  scope={socialService}
                  onOpenLink={(href) => {
                    try {
                      const next = resolveNavigationInput(href);
                      if (next.kind === 'nym' && next.address !== socialService) {
                        void openPortalWorkspace(href);
                        return;
                      }
                    } catch {
                      // Fall through to the normal resolver's error surface.
                    }
                    void goTo(href);
                  }}
                  onOpenWorkspace={(next) => void openPortalWorkspace(next)}
                  onStatus={append}
                />
              )}

              {socialService && (
                <Social key={socialService} service={socialService} trustMap={trustMap} onVerdict={onVerdict} />
              )}
            </main>
          )}

          {view === 'service' && <RunPortal onProbe={onProbePortal} busy={busy} />}

          {view === 'settings' && (
            <main>
              <section className="fly-card" aria-label="Private network">
                <h2>Private network</h2>
                <p>One switch for your protection. Details live under Advanced.</p>
                <div className="fly-row">
                  {status.state !== 'ready' ? (
                    <button className="fly-btn fly-btn-primary" onClick={() => void onConnect()} disabled={busy}>
                      Connect privately
                    </button>
                  ) : (
                    <button className="fly-btn" onClick={() => void onDisconnect()} disabled={busy}>
                      Switch off
                    </button>
                  )}
                  <button className="fly-btn" onClick={() => void onProveTunnel()} disabled={busy}>
                    Prove I am protected
                  </button>
                </div>
                {lastError !== null && lastError !== undefined && (
                  <FriendlyError error={lastError} onRetry={onConnect} retrying={busy} />
                )}
              </section>

              {selfAddress ? (
                <ShareCard address={selfAddress} petname={null} linkLabel="My private link" />
              ) : (
                <section className="fly-card" aria-label="My private link">
                  <h2>My private link</h2>
                  <p>Turn on private messages to get a link you can share.</p>
                  <button className="fly-btn" onClick={() => void onStartMessaging()} disabled={busy}>
                    Turn on private messages
                  </button>
                </section>
              )}

              <section className="fly-card" aria-label="People">
                <h2>People</h2>
                <p>Names you chose for private links. Everything stays on this device.</p>
                <ContactsPanel
                  contacts={contacts}
                  pending={pendingInvite}
                  onVisit={onVisitContact}
                  onRemove={onRemoveContact}
                  onAccept={onAcceptInvite}
                  onDismissInvite={() => setPendingInvite(null)}
                  onTrustVouched={onTrustVouched}
                  petname={petname}
                  onPetnameChange={setPetname}
                />
              </section>

              <section className="fly-card" aria-label="Advanced settings">
                <div className="fly-row fly-row-between">
                  <div>
                    <h2 className="fly-h2-flush">Advanced</h2>
                    <p className="fly-meta fly-mt-1">Technical tools. Hidden unless you need them.</p>
                  </div>
                  <button className="fly-btn" aria-expanded={advanced} onClick={() => onToggleAdvanced(!advanced)}>
                    {advanced ? 'Hide advanced' : 'Show advanced'}
                  </button>
                </div>
                {advanced && (
                  <div className="fly-mt-4">
                    <Toolbar open={openPanels} onToggle={onTogglePanel} statusLabel={label} statusTone={tone} />

                    {openPanels.includes('connection') && (
                      <Panel title="Connection (technical)" onClose={() => onClosePanel('connection')}>
                        <div className="fly-row">
                          {spent ? (
                            <button className="fly-btn" onClick={() => void onReconnect()} disabled={busy}>
                              Reconnect in place
                            </button>
                          ) : (
                            <button className="fly-btn" onClick={() => void onConnect()} disabled={busy}>
                              Connect
                            </button>
                          )}
                          <button className="fly-btn" onClick={onHardReload}>
                            Reload app
                          </button>
                          <button className="fly-btn" onClick={() => void onProveTunnel()} disabled={busy}>
                            Prove tunnel (IP comparison)
                          </button>
                          <button className="fly-btn" onClick={() => void onDisconnect()} disabled={busy}>
                            Disconnect
                          </button>
                        </div>
                        <ul className="fly-list">
                          <li>Clearnet source IP: {clearnetIp || '—'}</li>
                          <li>Mixnet source IP: {mixnetIp || '—'}</li>
                          <li>Hop model: entry gateway → 3 mix layers → destination gateway (5 Sphinx hops)</li>
                          <li>
                            Requests on current exit: {exit.requests}
                            {exit.recommendReconnect && ' — reconnect recommended to change exit (§5.2.2)'}
                          </li>
                        </ul>
                      </Panel>
                    )}

                    {openPanels.includes('messages') && (
                      <Panel
                        title="Pure mixnet messaging (Nym address + SURBs)"
                        onClose={() => onClosePanel('messages')}
                      >
                        <div>
                          <button
                            className="fly-btn"
                            onClick={() => void onStartMessaging()}
                            disabled={busy || Boolean(selfAddress)}
                          >
                            Start messaging client
                          </button>
                          {selfAddress && <p className="fly-meta fly-break-all">My address: {selfAddress}</p>}
                          <div className="fly-row fly-mt-2">
                            <input
                              className="fly-input"
                              placeholder="recipient Nym address (id.enc@gw)"
                              value={recipient}
                              onChange={(e) => setRecipient(e.target.value)}
                            />
                            <input
                              className="fly-input"
                              placeholder="message"
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                            />
                            <button className="fly-btn" onClick={() => void onSend()}>
                              Send
                            </button>
                          </div>
                          <h3 className="fly-h3">Inbox</h3>
                          <ul className="fly-list">
                            {inbox.map((m, i) => (
                              <li key={i}>
                                {m.text}{' '}
                                {m.senderTag && (
                                  <button className="fly-btn fly-btn-sm" onClick={() => void onReply(m)}>
                                    reply via SURB
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </Panel>
                    )}

                    {openPanels.includes('fetch') && (
                      <Panel title="Private-site fetch (manual)" onClose={() => onClosePanel('fetch')}>
                        <p className="fly-muted">
                          Fetch a page from a private site by address. One call, one response — no Connect needed.
                        </p>
                        <div className="fly-row fly-mt-2">
                          <input
                            className="fly-input"
                            placeholder="private-site address"
                            value={hsAddress}
                            onChange={(e) => setHsAddress(e.target.value)}
                          />
                          <input
                            className="fly-input fly-field-sm"
                            placeholder="/path"
                            value={hsPath}
                            onChange={(e) => setHsPath(e.target.value)}
                          />
                          <button className="fly-btn" onClick={() => void onFetchNym()} disabled={busy}>
                            Fetch
                          </button>
                        </div>
                        {hsResult && <pre className="fly-pre fly-mt-2">{hsResult}</pre>}
                      </Panel>
                    )}

                    {openPanels.includes('log') && (
                      <Panel title="Log (technical)" onClose={() => onClosePanel('log')}>
                        <pre className="fly-pre">{log.join('\n')}</pre>
                      </Panel>
                    )}

                    {openPanels.includes('contacts') && (
                      <Panel title="Contacts (technical view)" onClose={() => onClosePanel('contacts')}>
                        <ContactsPanel
                          contacts={contacts}
                          pending={pendingInvite}
                          onVisit={onVisitContact}
                          onRemove={onRemoveContact}
                          onAccept={onAcceptInvite}
                          onDismissInvite={() => setPendingInvite(null)}
                          onTrustVouched={onTrustVouched}
                          petname={petname}
                          onPetnameChange={setPetname}
                        />
                      </Panel>
                    )}

                    {openPanels.includes('portal') && (
                      <Panel title="Portal replica (reads)" onClose={() => onClosePanel('portal')}>
                        <PortalSync />
                      </Panel>
                    )}

                    {openPanels.includes('downloads') && (
                      <Panel title="Downloads" onClose={() => onClosePanel('downloads')}>
                        <DownloadManager
                          entries={downloads}
                          onSaveAgain={(entry) => void saveDownloadAgain(entry)}
                          onRemove={(id) => {
                            downloadPartsRef.current.delete(id);
                            setDownloads((prev) => removeDownload(prev, id));
                          }}
                          onClear={() => {
                            downloadPartsRef.current.clear();
                            setDownloads(clearDownloads());
                          }}
                        />
                      </Panel>
                    )}
                  </div>
                )}
              </section>
            </main>
          )}
        </div>
        <ContextPanel
          view={view}
          open={contextOpen}
          onToggle={onToggleContext}
          portalService={socialService}
          portalBound={socialService !== ''}
          inviteFrom={pendingInvite?.inviter ?? null}
          threadLabel={activeThread ? threadLabel(activeThread, contacts) : null}
          threadAddress={activeThreadAddress}
          statusLabel={label}
          statusTone={tone}
          clearnetIp={clearnetIp}
          mixnetIp={mixnetIp}
          advanced={advanced}
          onToggleAdvanced={onToggleAdvanced}
        />
      </div>
    </div>
  );
}
