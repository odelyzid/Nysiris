import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ensureTunnel, teardownTunnel, tunnelState, tunnelSpent, type TunnelStateView } from '../../../mixnet/tunnel';
import { exitStatus, mixnetFetch, proveTunnel } from '../../../mixnet/fetch';
import { NymAddressClient, type IncomingMessage } from '../../../mixnet/messaging';
import { fetchNym, fetchNymFull } from '../../../mixnet/fetchNym';
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
  stopPage,
  tabTitle,
  type BrowserTab,
} from '../../../application/browser';
import { resolveNavigationInput, type NavigationTarget, type ParsedInvite } from '../../../application/navigation';
import { b64decode, b64encode } from '../../../lib/bytes';
import { prepareDocument, type ResourceKind, type ResourceResponse } from '../../../application/contentLoader';
import { DocumentCache } from '../../../application/documentCache';
import { CookieJar, loadCookieJar, saveCookieJar } from '../../../application/cookies';
import { loadScrollPositions, rememberScroll } from '../../../application/scrollStore';
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

function downloadName(title: string, contentType: string): string {
  const base = (title || 'download').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'download';
  const type = contentType.split(';')[0].trim().toLowerCase();
  const extension = DOWNLOAD_EXTENSIONS[type] ?? '';
  return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
}

export function App() {
  const [status, setStatus] = useState<TunnelStateView>({ state: 'shutdown' });
  // Set once the tunnel has been torn down: the one-shot WASM cannot be rebuilt
  // without a page reload, so the UI offers an explicit reconnect instead of a
  // second `ensureTunnel` call that is guaranteed to reject (§5.2.2).
  const [spent, setSpent] = useState(() => tunnelSpent());
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
  const [downloads, setDownloads] = useState<DownloadRecord[]>(() => loadDownloads(defaultStorage()));

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
        append(`exit reuse: ${next.requests} requests on one exit — reload the page to rotate your exit (§5.2.2)`);
      }
      setExit(next);
    }, 2000);
    return () => window.clearInterval(id);
  }, [append]);

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

  // The only way to bring the one-shot tunnel back (or to rotate the exit) is a
  // full page reload: it rebuilds the WASM tunnel from scratch (§5.2.2).
  const onReconnect = useCallback(() => {
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
      const text = new TextDecoder().decode(res.body);
      setHsResult(`status=${res.status} error=${res.error ?? 'none'}\n${text.slice(0, 2000)}`);
      append(`fetchNym done: status=${res.status} body=${res.body.length}B`);
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

  /** mixnetFetch plus the app-level cookie jar for clearnet requests. */
  const mixnetRequest = useCallback(async (url: string, init?: RequestInit): Promise<Response> => {
    const jar = cookieJarRef.current;
    const cookie = jar?.headerFor(url) ?? '';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) init.headers.forEach((value, key) => (headers[key] = value));
      else if (Array.isArray(init.headers)) for (const [key, value] of init.headers) headers[key] = value;
      else Object.assign(headers, init.headers);
    }
    if (cookie) headers.cookie = cookie;
    const res = await mixnetFetch(url, { ...init, headers });
    const withSetCookie = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = withSetCookie.getSetCookie?.() ?? [];
    if (setCookies.length === 0) {
      const single = res.headers.get('set-cookie');
      if (single) setCookies.push(single);
    }
    if (jar && setCookies.length > 0) {
      for (const value of setCookies) jar.setFromHeader(url, value);
      saveCookieJar(defaultStorage(), jar);
    }
    return res;
  }, []);

  /**
   * Fetch one page subresource through the same transport as the document.
   * The content loader only ever receives this callback, never native fetch.
   */
  const fetchSubresource = useCallback(
    async (url: string, kind: ResourceKind): Promise<ResourceResponse | null> => {
      let target: NavigationTarget;
      try {
        target = resolveNavigationInput(url);
      } catch {
        return null;
      }
      try {
        if (target.kind === 'nym') {
          const accept =
            kind === 'image'
              ? 'image/*,*/*;q=0.8'
              : kind === 'stylesheet'
                ? 'text/css,*/*;q=0.1'
                : kind === 'media'
                  ? 'audio/*,video/*,*/*;q=0.1'
                  : '*/*';
          const res = await fetchNymFull(
            target.address,
            { method: 'GET', path: target.path, headers: { accept } },
            {
              timeoutMs: 30_000,
              maxBytes: kind === 'other' ? 32 * 1024 * 1024 : 4 * 1024 * 1024,
            },
          );
          if (res.error) return null;
          return { status: res.status, contentType: res.headers['content-type'] ?? '', bytes: res.body };
        }
        const res = await mixnetRequest(url);
        return {
          status: res.status,
          contentType: res.headers.get('content-type') ?? '',
          bytes: new Uint8Array(await res.arrayBuffer()),
        };
      } catch {
        return null;
      }
    },
    [mixnetRequest],
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
      options: { push: boolean; historyIndex?: number; token: number; force?: boolean; redirects?: number },
    ) => {
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

      const cached = options.force ? null : documentCacheRef.current.get(target.url);
      if (cached) {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId
              ? applyPage(tab, options.token, {
                  status: cached.status,
                  contentType: cached.contentType,
                  body: cached.body,
                  favicon: cached.favicon,
                })
              : tab,
          ),
        );
        return;
      }

      activeLoadsRef.current += 1;
      setBusy(true);

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
          const res = await fetchNymFull(
            target.address,
            { method: 'GET', path: target.path, headers: { accept: 'text/html' } },
            { timeoutMs: 120_000, maxBytes: MAX_PAGE_BYTES },
          );
          if (res.body.length > MAX_PAGE_BYTES) {
            setTabs((prev) =>
              prev.map((tab) =>
                tab.id === tabId ? failPage(tab, options.token, `page is too large (${res.body.length} bytes)`) : tab,
              ),
            );
            append(`nym:// page too large: ${res.body.length} bytes`);
            return;
          }
          const contentType = res.headers['content-type'] ?? '';
          const error = res.error;
          if (!error && res.status >= 300 && res.status < 400 && res.headers.location) {
            const redirects = (options.redirects ?? 0) + 1;
            if (redirects > 5) {
              setTabs((prev) =>
                prev.map((tab) => (tab.id === tabId ? failPage(tab, options.token, 'too many redirects') : tab)),
              );
              return;
            }
            let next: NavigationTarget;
            try {
              next = resolveNavigationInput(new URL(res.headers.location, target.url).toString());
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
              token: (navigationSeqRef.current += 1),
              redirects,
            });
            return;
          }
          const text = new TextDecoder().decode(res.body);
          if (error) {
            setTabs((prev) => prev.map((tab) => (tab.id === tabId ? failPage(tab, options.token, error) : tab)));
            setHsResult(`status=${res.status} error=${error}`);
            append(`nym:// done with service error: ${error}`);
            return;
          }
          const kind = pageKindFor(contentType, text);
          let body = text;
          let effectiveType = contentType;
          let favicon: string | null = null;
          if (kind === 'image' || kind === 'media' || kind === 'pdf' || kind === 'binary') {
            body = dataUrlFor(res.body, contentType);
          } else if (kind === 'html') {
            try {
              const prepared = await prepareDocument(text, target.url, fetchSubresource);
              body = prepared.html;
              effectiveType = 'text/html; charset=utf-8';
              favicon = prepared.favicon;
              if (prepared.stats.resources > 0) {
                append(
                  `page assets: ${prepared.stats.resources} fetched, ${prepared.stats.failed} unavailable` +
                    (prepared.stats.truncated ? ' (capped)' : ''),
                );
              }
            } catch (err) {
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
          setTabs((prev) =>
            prev.map((tab) =>
              tab.id === tabId
                ? applyPage(tab, options.token, { status: res.status, contentType: effectiveType, body, favicon })
                : tab,
            ),
          );
          documentCacheRef.current.set(target.url, {
            status: res.status,
            contentType: effectiveType,
            body,
            favicon,
          });
          setRecentPortals((prev) => {
            const next = rememberPortal(prev, target.address);
            saveRecentPortals(next, defaultViewStorage());
            return next;
          });
          setHsResult(`status=${res.status} body=${res.body.length}B (rendered in the tab)`);
          append(`nym:// done: status=${res.status} body=${res.body.length}B`);
        } catch (err) {
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
        const res = await mixnetRequest(target.url);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > MAX_PAGE_BYTES) {
          setTabs((prev) =>
            prev.map((tab) =>
              tab.id === tabId ? failPage(tab, options.token, `page is too large (${bytes.length} bytes)`) : tab,
            ),
          );
          append(`web page too large: ${bytes.length} bytes`);
          return;
        }
        const contentType = res.headers.get('content-type') ?? '';
        const decoded = new TextDecoder().decode(bytes);
        const kind = pageKindFor(contentType, decoded);
        const text = kind === 'image' || kind === 'media' || kind === 'pdf' || kind === 'binary' ? '' : decoded;
        let body = text;
        let effectiveType = contentType;
        let favicon: string | null = null;
        if (kind === 'image' || kind === 'media' || kind === 'pdf' || kind === 'binary') {
          body = dataUrlFor(bytes, contentType);
        } else if (kind === 'html') {
          try {
            // `mixnetFetch` follows redirects; resolve relative assets against
            // the final document URL, not the one the user typed.
            const documentUrl = res.url || target.url;
            const prepared = await prepareDocument(text, documentUrl, fetchSubresource);
            body = prepared.html;
            effectiveType = 'text/html; charset=utf-8';
            favicon = prepared.favicon;
            if (prepared.stats.resources > 0) {
              append(
                `page assets: ${prepared.stats.resources} fetched, ${prepared.stats.failed} unavailable` +
                  (prepared.stats.truncated ? ' (capped)' : ''),
              );
            }
          } catch (err) {
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
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId
              ? applyPage(tab, options.token, { status: res.status, contentType: effectiveType, body, favicon })
              : tab,
          ),
        );
        documentCacheRef.current.set(target.url, {
          status: res.status,
          contentType: effectiveType,
          body,
          favicon,
        });
        setHsResult(`status=${res.status} body=${body.length}B (rendered in the tab)`);
        append(`web done: status=${res.status} body=${body.length}B`);
      } catch (err) {
        setTabs((prev) => prev.map((tab) => (tab.id === tabId ? failPage(tab, options.token, String(err)) : tab)));
        setLastError(err);
        append(`web failed: ${String(err)}`);
      } finally {
        activeLoadsRef.current = Math.max(0, activeLoadsRef.current - 1);
        setBusy(activeLoadsRef.current > 0);
      }
    },
    [append, fetchSubresource, mixnetRequest],
  );

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
      const token = (navigationSeqRef.current += 1);
      onSelectView('portal');
      await loadInto(target, tabId, { push: true, token });
    },
    [activeTab?.id, append, loadInto, navigationPetnames, onSelectView, tabs],
  );

  const onGo = useCallback(() => {
    void goTo(uri);
  }, [goTo, uri]);

  const onAddressChange = useCallback((value: string) => {
    setUri(value);
    setNavigationError(null);
  }, []);

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
  }, [goTo]);

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

  /** Re-fetch a tab's current URL without pushing a history entry. */
  const reloadTab = useCallback(
    async (tab: BrowserTab, historyIndex?: number) => {
      let target: NavigationTarget;
      try {
        target = resolveNavigationInput(tab.url);
      } catch (err) {
        setNavigationError(err instanceof Error ? err.message : String(err));
        return;
      }
      const token = (navigationSeqRef.current += 1);
      await loadInto(target, tab.id, { push: false, historyIndex, token, force: true });
    },
    [loadInto],
  );

  const onBack = useCallback(() => {
    if (!activeTab) return;
    const entry = historyEntry(activeTab, -1);
    if (!entry) return;
    const token = (navigationSeqRef.current += 1);
    let target: NavigationTarget;
    try {
      target = resolveNavigationInput(entry.url);
    } catch (err) {
      setNavigationError(err instanceof Error ? err.message : String(err));
      return;
    }
    void loadInto(target, activeTab.id, { push: false, historyIndex: entry.index, token });
  }, [activeTab, loadInto]);

  const onForward = useCallback(() => {
    if (!activeTab) return;
    const entry = historyEntry(activeTab, 1);
    if (!entry) return;
    const token = (navigationSeqRef.current += 1);
    let target: NavigationTarget;
    try {
      target = resolveNavigationInput(entry.url);
    } catch (err) {
      setNavigationError(err instanceof Error ? err.message : String(err));
      return;
    }
    void loadInto(target, activeTab.id, { push: false, historyIndex: entry.index, token });
  }, [activeTab, loadInto]);

  const onReload = useCallback(() => {
    if (!activeTab?.url) return;
    void reloadTab(activeTab);
  }, [activeTab, reloadTab]);

  const onStop = useCallback(() => {
    if (!activeTab) return;
    setTabs((prev) => prev.map((tab) => (tab.id === activeTab.id ? stopPage(tab) : tab)));
  }, [activeTab]);

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
    const name = downloadName(activeTab.title || tabTitle(activeTab), contentType);
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
      }),
    );
  }, [activeTab]);

  const saveDownloadAgain = useCallback(
    async (entry: DownloadRecord) => {
      setDownloads((prev) => updateDownload(prev, entry.id, { status: 'pending', error: undefined }));
      const res = await fetchSubresource(entry.url, 'other');
      if (!res) {
        setDownloads((prev) =>
          updateDownload(prev, entry.id, {
            status: 'failed',
            error: 'Could not fetch the file again through the mixnet.',
          }),
        );
        return;
      }
      saveBlob(res.bytes, res.contentType || entry.contentType, entry.name);
      setDownloads((prev) =>
        updateDownload(prev, entry.id, {
          status: 'saved',
          size: res.bytes.length,
          contentType: res.contentType || entry.contentType,
          error: undefined,
        }),
      );
    },
    [fetchSubresource],
  );

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
  // persisted). The ref keeps StrictMode's development double-effect in check.
  useEffect(() => {
    if (bootRestoredRef.current) return;
    bootRestoredRef.current = true;
    const tab = tabs.find((candidate) => candidate.id === activeTabId);
    if (tab?.url && !tab.content && !tab.loading) void reloadTab(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

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
      void goTo(address);
      onSelectView('portal');
    },
    [goTo, onSelectView],
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
                      <button className="fly-btn fly-btn-primary" onClick={onReconnect}>
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
                        <button className="fly-btn" onClick={onReconnect}>
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
                />
              )}

              {activeTab?.content && (activeTab.content.kind === 'text' || activeTab.content.kind === 'json') && (
                <pre className="fly-pre fly-portal-text" aria-label="Page content">
                  {activeTab.content.body.slice(0, 200_000)}
                </pre>
              )}

              {activeTab?.content?.kind === 'image' && (
                <img className="fly-portal-image" src={activeTab.content.body} alt={tabTitle(activeTab)} />
              )}

              {activeTab?.content?.kind === 'media' &&
                (activeTab.content.contentType.startsWith('video/') ? (
                  <video
                    className="fly-portal-media"
                    src={activeTab.content.body}
                    controls
                    playsInline
                    aria-label={tabTitle(activeTab)}
                  />
                ) : (
                  <audio
                    className="fly-portal-media"
                    src={activeTab.content.body}
                    controls
                    aria-label={tabTitle(activeTab)}
                  />
                ))}

              {activeTab?.content?.kind === 'pdf' && (
                <PdfView dataUrl={activeTab.content.body} title={tabTitle(activeTab)} />
              )}

              {activeTab?.content?.kind === 'binary' && (
                <section className="fly-card" aria-label="Download">
                  <p className="fly-muted">
                    {activeTab.content.contentType || 'Binary content'} — this build does not render this file type.
                  </p>
                </section>
              )}

              {activeTab?.content && ['image', 'media', 'pdf', 'binary'].includes(activeTab.content.kind) && (
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

              {activeTab?.url && !activeTab.content && !activeTab.loading && !activeTab.error && (
                <section className="fly-card" aria-label="Restored tab">
                  <p className="fly-muted">This tab was restored. Load it when you’re ready.</p>
                  <button className="fly-btn fly-btn-primary" onClick={() => void reloadTab(activeTab)}>
                    Load {activeTab.kind === 'nym' ? shortenAddress(activeTab.address) : activeTab.address}
                  </button>
                </section>
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
                            <button className="fly-btn" onClick={onReconnect}>
                              Reconnect
                            </button>
                          ) : (
                            <button className="fly-btn" onClick={() => void onConnect()} disabled={busy}>
                              Connect
                            </button>
                          )}
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
                          onRemove={(id) => setDownloads((prev) => removeDownload(prev, id))}
                          onClear={() => setDownloads(clearDownloads())}
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
