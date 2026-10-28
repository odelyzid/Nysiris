# 15. Browser Document, Tabs, and Unified Navigation

**Status:** Phases 1–5 are implemented. Phase 5’s portal surface now includes
per-portal replicas/identity/trust, post/profile/wiki authoring, background
replication while the app is open, offline media/attachment caching, workspace
navigation, conflict recovery, and legacy-replica migration.

This document is the implementation plan for turning the Portal view into a
real browser document model. It complements the browser-capability audit and
the remaining phases in [`06-roadmap.md`](06-roadmap.md).

The target is **not** an arbitrary-Web browser yet. Phase 1 gives Nysiris a
proper document/tab lifecycle and one navigation pipeline for both address
spaces it can already reach:

| Space | Transport | Address form |
|---|---|---|
| Pure mixnet service | `fetchNym` + `NymAddressClient` | `nym://<id>.<enc>@<gw>/path` |
| Clearnet / exit-gateway Web | `mixnetFetch` + `@nymproject/mix-fetch` | `http://…` / `https://…` |

Clearnet responses currently render in the same sandboxed document viewer as
portal pages. Scripts, forms, and a real page engine are later phases (see
§15.7).

---

## 15.1 Goals

1. One **document model** per tab: URL, kind, content, status, error, history,
   loading token.
2. **Tabs**: create, select, close, restore; each tab keeps its own history.
3. **Navigation controls**: back, forward, reload, stop, and a unified address
   bar.
4. **Unified resolution**: one function decides whether input is a `nym://`
   address, a bare Nym address, a petname, or an `http(s)` URL.
5. **Safe async application**: a slow response from tab A must never write
   into tab B, or into a newer navigation in the same tab.
6. **Persistence**: tab list, URLs, titles, and history survive a reload.
   Page bodies are intentionally not persisted in Phase 1.
7. Keep the model pure and unit-testable without a DOM.

## 15.2 Non-goals for Phase 1

- Subresource loading (CSS/images/fonts/scripts) and a base URL.
- Executing page JavaScript, forms, or site storage.
- Cookies, redirects, auth sessions, `HEAD`/`Range`, caching.
- Download manager, find-in-page, zoom, print, media/PDF.
- Multi-process/privacy container isolation.
- Persisting page bodies or restoring an active Nym connection.

Those are tracked in §15.7 and in the browser gap audit.

---

## 15.3 Data model

Implemented in `web/src/application/browser.ts`.

```ts
type PageKind = 'html' | 'text' | 'json';

interface PageContent {
  kind: PageKind;
  contentType: string;
  body: string;
}

interface BrowserTab {
  id: string;
  kind: 'nym' | 'clearnet' | null;
  url: string;          // canonical URL shown in the address bar
  address: string;      // Nym service address or clearnet origin
  path: string;         // request path (+ query for clearnet)
  service: string;      // Nym service for Social binding; '' for clearnet
  title: string;
  content: PageContent | null;
  status: number | null;
  error: string | null;
  loading: boolean;
  history: string[];    // canonical URLs only
  historyIndex: number;
  navToken: number;     // monotonic guard for async results
}
```

Rules:

- `url` is canonical and is the only thing persisted for history.
- `service` is set only for `nym` tabs; clearnet pages never bind Social.
- `navToken` increments on every navigation/stop; `applyPage`, `failPage`, and
  `stopPage` are no-ops when the token is stale.
- Page bodies live in memory only.
- Empty tabs have `kind = null`, `url = ''`, `service = ''`.

## 15.4 Navigation resolution

Implemented in `web/src/application/navigation.ts`.

`resolveNavigationInput(input, { petnames })` returns one of:

```ts
{ kind: 'nym', url, address, path, invite }
{ kind: 'clearnet', url, address, path, invite: null }
```

Rules:

1. Trim input; empty input is an error.
2. Exact petname lookup (case-insensitive) expands to a saved Nym address.
3. `http://` / `https://` → clearnet target, canonicalised by `URL`.
4. `nym://…`, bare `<id>.<enc>@<gw>[/path]`, and invite links → Nym target via
   `parseInviteLink`.
5. Any other scheme (`javascript:`, `file:`, `data:`, …) is rejected.
6. Invite fragments are parsed but never included in the canonical URL, so
   they cannot leak into history or the wire request.

## 15.5 Navigation pipeline

```text
address bar / saved link / contact / back / forward / reload
                              │
                    resolveNavigationInput
                              │
              tab = navigate(tab, target, token, push?)
                              │
        ┌─────────────────────┴─────────────────────┐
        │ nym                                       │ clearnet
   fetchNym(address, path, Accept: text/html)   clearnetFetch(url)
        │                                           │
        └─────────────────────┬─────────────────────┘
                              │
             applyPage(tab, token, { status, contentType, body })
                              │
              html → sandboxed iframe; text/json → preformatted
```

Back/forward move `historyIndex` and re-fetch that URL without pushing a new
entry. Reload re-fetches the current URL. Stop aborts the per-tab
`AbortController`: the Nym envelope client drops its correlation waiter and the
clearnet fetch races the signal, so a late reply cannot write into the tab.
All state changes are applied by tab id + token.

Every request also goes through the shared HTTP semantics:

- clearnet redirects are followed by `clearnetFetch`; when the transport exposes
  each hop (`redirect: 'manual'`), its `Set-Cookie` updates the jar and the
  final URL becomes the document base;
- `401` + `WWW-Authenticate: Basic` opens the in-page sign-in card and retries
  with an in-memory credential (passwords are never persisted);
- `ETag`/`Last-Modified` from a cached document become `If-None-Match` /
  `If-Modified-Since` on reload; `304` reuses the prepared body (back/forward
  serves the in-session cache immediately);
- `Content-Encoding` (`gzip`, `deflate`, `br` where the engine supports it) is
  decoded before rendering or inlining.

## 15.6 Persistence

Key: `fly.browser.tabs.v1` (`localStorage`).

Persisted per tab: `id`, `kind`, `url`, `address`, `path`, `service`, `title`,
`history`, `historyIndex`. Active tab id is stored with the list. On restore,
content is `null` and `loading` is `false`; the UI shows the tab as restored
and reloads it when selected.

Limits: 12 tabs, 50 history entries per tab. Malformed storage falls back to a
single blank tab.

## 15.7 Phases

### Phase 1 — document/tab model + unified navigation (implemented)

- [x] Pure tab/history model with stale-response guards.
- [x] Pure URL/petname resolver for `nym://` + `http(s)`.
- [x] Tab strip, new/close/select, back/forward/reload/stop.
- [x] Unified address bar replacing the Portal-only URI input.
- [x] `mixnetFetch` wired into navigation for clearnet URLs.
- [x] Tab/history persistence.
- [x] Unit tests for model, history, serialization, and resolution.
- [x] In-session document cache for back/forward; page bodies are not persisted
      across a full app reload.

**Acceptance:** open two tabs, navigate one to a Nym portal and one to an
`https://` URL, switch between them, use back/forward, reload, stop a slow
load, close a tab, and reload the app — the tab list and histories survive.

### Phase 2 — content loader (core implemented)

- [x] Base URL and subresource fetching through the same transport.
- [x] HTML/CSS/images inlined; JSON/text rendered by the tab viewer.
- [x] Link interception inside the sandboxed document (`data-nysiris-href`).
- [x] `<title>` extraction and tab labels.
- [x] Budgeted resource loading (24 resources, 2 MiB each, 8 MiB total).
- [x] Favicon extraction/inlining and tab labels.
- [x] Scroll restoration by canonical URL.
- [x] In-session document cache (24 pages / 16 MiB LRU).
- [x] Top-level media (`audio`/`video`), PDF viewer, and embedded media inlining.
- [x] Download shelf: save page, save again, remove/clear, metadata persistence.
- [x] `Content-Disposition` filename parsing and a resume-capable downloader
      (`HEAD` metadata + `Range`/`If-Range`, partial bytes retained in memory).
- [x] Embedded PDF/object documents and media range streaming.
      `<object>`/`<embed>` become app-level document cards; top-level and
      fallback media use a service-worker range bridge; small embedded media
      stays inlined under the existing budget.

**Implemented in** `web/src/application/contentLoader.ts`. Fetched documents
are sanitised: scripts, frames, plugins, meta refresh, event handlers, and
external SVG references are removed; every CSS `url(...)`/`@import`, image,
favicon, poster, audio, and video source is routed through the injected fetcher
and replaced with a data URL. Links become `data-nysiris-href` values that the
app shell intercepts and opens in the owning tab. The prepared document also
carries its own restrictive CSP as defence in depth.

**Acceptance (met):** a portal page with local CSS and images renders without
clearnet requests; clicking an in-page link stays in the tab. Scripts and forms
remain deliberately disabled; embedded PDF/object documents are extracted into
openable cards, and clearnet cookies are handled by the Phase 3 jar.

### Phase 3 — HTTP semantics (implemented)

- [x] Clearnet redirects followed by `clearnetFetch`; when the transport honours
      `redirect: 'manual'`, each hop's `Set-Cookie` updates the per-origin jar
      and the final URL becomes the document base.
- [x] Nym `3xx` + `Location` redirects with a five-hop limit.
- [x] Per-origin cookie jar (domain/path/expiry/secure) wired into clearnet
      requests and `Set-Cookie` responses.
- [x] `Basic` authentication UI for clearnet and Nym documents; credentials are
      session-only (never written to `localStorage`).
- [x] Cache validators: `ETag`/`Last-Modified` stored with the prepared document
      and sent back as `If-None-Match`/`If-Modified-Since`; `304` reuses the
      cached body without re-rendering. (`@nymproject/mix-fetch` 2.1.1 cannot
      construct a null-body `Response` for a clearnet `304`; the shell detects
      that once, falls back to an unconditional reload, and keeps revalidation
      for Nym and future transports.)
- [x] `Content-Encoding` decoding before rendering/inlining.
- [x] `Range`/`206` support in `nysiris-sdk` static files, with
      `If-None-Match`/`304` and `If-Range` revalidation.
- [x] `fetchNymFull` reassembles `Content-Range` chunks.
- [x] Static files larger than one mixnet message are served in chunks instead
      of `413`; pages/downloads accept up to 8/32 MiB.
- [x] Download metadata comes from `HEAD` (`Content-Length`,
      `Content-Type`, `Content-Disposition`, `ETag`, `Accept-Ranges`).
- [x] Resumable downloads: failed/timeout attempts keep received bytes in
      memory, resume with `Range: bytes=<received>-` and `If-Range`, and restart
      cleanly if the server answers `200`.
- [x] Per-in-flight-request cancellation: Stop aborts the tab's
      `AbortController`, removes the Nym correlation waiter, aborts subresource
      loading, and races clearnet transport promises.

**Implemented in** `web/src/application/cookies.ts`,
`web/src/application/auth.ts`, `web/src/application/clearnet.ts`,
`web/src/application/httpHeaders.ts`, `web/src/application/encoding.ts`,
`web/src/application/downloadTransfer.ts`, `web/src/application/ranges.ts`,
`web/src/mixnet/fetchNym.ts`, `web/src/lib/abort.ts`, and
`crates/nysiris-sdk/src/files.rs`.

**Acceptance (met):** a multi-KB static page is served and rendered; redirects
are followed and redirect cookies are retained; a reload revalidates with an
`ETag` and renders a `304` from cache; gzip/deflate responses render correctly;
a `401` prompts for credentials; a dropped download resumes from its offset;
Stop aborts the transport instead of only hiding the result.

### Phase 4 — browser lifecycle (implemented)

- [x] In-place reconnect without a page reload; tabs/history stay mounted and
      the active document reloads on the new tunnel.
- [x] Tab restoration after reconnect (URLs/history persistence is unchanged;
      other tabs load on selection).
- [x] React error boundary plus a global async-error banner; recovery keeps the
      app alive, and "Restart cleanly" clears only the offline shell cache.
- [x] Session restore of iframe and text/JSON scroll positions.
- [x] Service worker app-shell cache with offline start-up and an offline banner.
- [x] Per-site permissions UI and persisted allow/ask/block decisions.
- [x] Find-in-page for HTML (DOM matches) and text/JSON (highlighted segments),
      with `Ctrl/Cmd+F`, Enter/Shift+Enter, and match count.
- [x] Zoom controls (50–200 %, persisted) with `Ctrl/Cmd +/-/0`.
- [x] Print the active document through a sanitised print window.
- [x] OS `nym://` handling: Debian/desktop launcher `%u`, Electron protocol +
      single-instance forwarding, Android `VIEW` intent, and Capacitor
      `appUrlOpen`.

**Implemented in** `web/src/mixnet/tunnel.ts` (`reconnectTunnel`),
`web/src/pwa.ts` + `web/public/sw.js`, `web/src/application/zoom.ts`,
`web/src/application/find.ts`, `web/src/application/permissions.ts`,
`web/src/application/deepLinks.ts`, `web/src/shared/print.ts`,
`web/src/adapters/driving/shell/ErrorBoundary.tsx`,
`BrowserTools.tsx`, `PermissionsPanel.tsx`, `findInDocument.ts`, and
`web/src/adapters/driven/deepLink.ts`.

**Acceptance (met where the runtime allows):** switching off and reconnecting
keeps the tab strip and history; a render throw shows a recoverable screen; the
app shell starts offline; find/zoom/print work on both HTML and text documents;
a second `nym://` launch opens in the running desktop instance. If the installed
mix-tunnel WASM refuses to be reinitialised, the UI explains the failure and
offers the documented hard-reload fallback.

### Phase 5 - portal/Osiris surface (implemented)

- [x] Versioned object schema for `site/index`, `profile`, `post`, `wiki/page`,
      `wiki/index`, and generic objects.
- [x] Fresh per-portal ed25519 author keys, isolated from the social and
      portal-service identities.
- [x] Escaped Markdown subset renderer (no raw HTML).
- [x] Per-portal replica storage: IndexedDB content + localStorage metadata.
- [x] Per-portal trust/block decisions; no cross-portal leakage.
- [x] Structured sync conflicts and explicit manual author-log reset.
- [x] Post, profile, and wiki/page authoring with optional PoW publishing.
- [x] Portal workspace store/switcher; opening a workspace reuses its tab or
      creates one, and cross-portal links open the owning workspace.
- [x] Automatic/background replication while the app is open, with backoff,
      online/visibility wakeups, and pause controls.
- [x] Offline reader: replicas and generic attachments persist; media/PDF can be
      saved for offline playback through the range cache.
- [x] One-time migration notice/import for the pre-workspace global replica
      (`fly.portal.sync.v1`).

**Implemented in** `web/src/domain/portalContent.ts`,
`portalLww.ts`, `portalWrite.ts`, `web/src/application/portalStore.ts`,
`portalIdentity.ts`, `portalTrust.ts`, `portalWorkspaces.ts`,
`portalConflict.ts`, `portalView.ts`, `portalMarkdown.ts`,
`portalScheduler.ts`, `portalMigration.ts`, `portalMediaCache.ts`,
`web/src/adapters/driven/portalWriteIo.ts`, and
`web/src/adapters/driving/portal/PortalWorkspace.tsx`.

---

## 15.8 File map

| File | Role |
|---|---|
| `web/src/application/browser.ts` | Tab/document model, history, serialization |
| `web/src/application/navigation.ts` | Address/petname resolution |
| `web/src/application/contentLoader.ts` | Sanitising content loader, CSS/image/media/favicon inlining, link rewriting |
| `web/src/application/documentCache.ts` | LRU prepared-page cache |
| `web/src/application/scrollStore.ts` | Per-URL scroll positions |
| `web/src/application/downloads.ts` | Download shelf metadata |
| `web/src/application/cookies.ts` | Clearnet cookie jar |
| `web/src/application/auth.ts` | `WWW-Authenticate` parsing + session credentials |
| `web/src/application/clearnet.ts` | Redirect chain, per-hop cookies, auth header, final URL |
| `web/src/application/httpHeaders.ts` | Validators, `Content-Disposition`, redirect/range headers |
| `web/src/application/embeddedDocuments.ts` | Object/embed classification and document descriptors |
| `web/src/application/mediaSession.ts` | Media tokens, streamability hints, session registry |
| `web/src/shared/mediaRange.ts` | Byte-range parsing for the media bridge |
| `web/src/adapters/driven/mediaBridge.ts` | App side of the SW range bridge |
| `web/src/domain/portalContent.ts` | Versioned portal payload schema |
| `web/src/domain/portalLww.ts` | Browser LWW merge |
| `web/src/application/portalIdentity.ts` | Per-portal author keys |
| `web/src/application/portalTrust.ts` | Per-portal trust decisions |
| `web/src/application/portalWorkspaces.ts` | Workspace metadata/store |
| `web/src/application/portalConflict.ts` | Conflict classification + manual reset |
| `web/src/application/portalStore.ts` | IndexedDB replica store + localStorage metadata |
| `web/src/application/portalView.ts` | Feed/wiki/profile view model |
| `web/src/application/portalMarkdown.ts` | Escaped Markdown subset |
| `web/src/application/portalScheduler.ts` | Background replication timing/backoff |
| `web/src/application/portalMigration.ts` | Legacy global replica notice/import |
| `web/src/application/portalMediaCache.ts` | Offline media/PDF cache |
| `web/src/domain/portalWrite.ts` | Signed object/log-entry builders |
| `web/src/application/encoding.ts` | `Content-Encoding` decoding |
| `web/src/application/downloadTransfer.ts` | Resumable `Range`/`If-Range` download assembly |
| `web/src/application/ranges.ts` | `Content-Range` parsing/chunk assembly |
| `web/src/application/zoom.ts` | Zoom steps, clamp, persistence |
| `web/src/application/find.ts` | Find matches + text highlight segments |
| `web/src/application/permissions.ts` | Per-site allow/ask/block decisions |
| `web/src/application/deepLinks.ts` | `nym://` launch-link parsing/encoding |
| `web/src/pwa.ts` | Service-worker registration + connectivity |
| `web/public/sw.js` | App-shell/runtime cache worker |
| `web/src/shared/print.ts` | Print-window document builder |
| `web/src/adapters/driven/deepLink.ts` | Query/Electron/Capacitor launch listeners |
| `web/src/adapters/driving/shell/ErrorBoundary.tsx` | Render boundary + async-error banner |
| `web/src/adapters/driving/shell/BrowserTools.tsx` | Find/zoom/print/permission/offline controls |
| `web/src/adapters/driving/shell/PermissionsPanel.tsx` | Per-site permission UI |
| `web/src/adapters/driving/shell/findInDocument.ts` | DOM highlight/search for the iframe |
| `web/src/adapters/driving/shell/MediaView.tsx` | Range-backed media player with data-URL fallback |
| `web/src/adapters/driving/shell/EmbeddedDocuments.tsx` | Extracted object/embed document cards |
| `web/src/adapters/driving/portal/PortalWorkspace.tsx` | Portal feed/wiki/profile, authoring, trust, conflicts |
| `web/src/adapters/driving/portal/PortalMarkdown.tsx` | Escaped Markdown React renderer |
| `web/src/adapters/driven/portalWriteIo.ts` | Signed portal publish transport (PoW + POST routes) |
| `web/src/lib/abort.ts` | AbortError + signal racing |
| `web/src/mixnet/fetchNym.ts` | Nym envelope client, abortable waiters, chunk reassembly |
| `crates/nysiris-sdk/src/files.rs` | Static files: `Range`, `ETag`/`304`, `If-Range` |
| `web/src/adapters/driving/shell/BrowserChrome.tsx` | Tab strip + navigation controls |
| `web/src/adapters/driving/shell/PdfView.tsx` | Blob-backed PDF viewer |
| `web/src/adapters/driving/portal/DownloadManager.tsx` | Download shelf UI |
| `web/src/adapters/driving/shell/App.tsx` | Navigation orchestration and page rendering |
| `web/src/adapters/driving/shell/DesktopShell.tsx` | Desktop top bar (view nav/status) |
| `web/test/browser.test.mjs` | Model/history/serialization tests |
| `web/test/navigation.test.mjs` | URL/petname resolution tests |
| `web/test/contentLoader.test.mjs` | Resource resolution, CSS inlining, and budgets |
| `web/test/documentCache.test.mjs` | LRU/byte limits and eviction |
| `web/test/scrollStore.test.mjs` | Scroll persistence and caps |
| `web/test/downloads.test.mjs` | Shelf add/update/remove/persist |
| `web/test/cookies.test.mjs` | Cookie domain/path/expiry matching |
| `web/test/auth.test.mjs` | Challenge parsing and credential lookup |
| `web/test/clearnet.test.mjs` | Redirect cookies, auth retry, final URL, limits |
| `web/test/httpHeaders.test.mjs` | Validators, filenames, redirects |
| `web/test/encoding.test.mjs` | gzip/deflate/stacked decoding |
| `web/test/downloadTransfer.test.mjs` | Resume, restart-on-200, abort, bounds |
| `web/test/embeddedDocuments.test.mjs` | Object/embed classification |
| `web/test/mediaSession.test.mjs` | Range parsing and media sessions |
| `web/test/portalContent.test.mjs` | Portal payload schema |
| `web/test/portalLww.test.mjs` | LWW merge/convergence |
| `web/test/portalIdentity.test.mjs` | Per-portal key isolation |
| `web/test/portalWorkspaces.test.mjs` | Workspace persistence |
| `web/test/portalTrust.test.mjs` | Per-portal trust isolation |
| `web/test/portalStoreConflict.test.mjs` | Replica store + manual reset |
| `web/test/portalWrite.test.mjs` | Signed authoring/wire JSON |
| `web/test/portalView.test.mjs` | Feed/wiki/profile view model |
| `web/test/portalMarkdown.test.mjs` | Escaped Markdown subset |
| `web/test/portalScheduler.test.mjs` | Background sync backoff/pause rules |
| `web/test/portalMigration.test.mjs` | Legacy replica detection/import |
| `web/test/portalMediaCache.test.mjs` | Offline media cache/range download |
| `web/test/ranges.test.mjs` | `Content-Range` parsing and chunk assembly |
| `web/test/zoom.test.mjs` | Zoom clamp/steps/persistence |
| `web/test/find.test.mjs` | Match rules, segments, wraparound |
| `web/test/permissions.test.mjs` | Per-site decisions and caps |
| `web/test/deepLinks.test.mjs` | Launch URL/argv parsing |
| `web/test/print.test.mjs` | Print document escaping |
| `web/test/pwa.test.mjs` | Offline helper degradation |

## 15.9 Migration notes

- `socialService` is now derived from the active tab’s `service`, not a
  separate piece of state. Navigating a tab away from a Nym service unbinds
  that tab from Social without touching other tabs.
- `pageHtml` is replaced by `tab.content`; HTML still renders in
  `sandbox=""`, and non-HTML content renders as text/JSON.
- The Home and Portal “open a link” cards remain as shortcuts, but both call
  the same navigation pipeline as the address bar.
- A tab with no URL is a blank document, not a hidden portal. Opening a saved
  link in the current tab pushes a history entry.
- HTTP credentials and partially received download bytes are session-only. The
  download shelf persists progress metadata (`received`, `total`, `ETag`) so a
  paused transfer can be resumed while the app stays open; after a reload the
  bytes are gone and the retry starts from byte zero.
- Phase 4 preferences use `fly.browser.zoom.v1` and
  `fly.browser.permissions.v1`. Both are device-local and safe to clear.
- The service worker caches only the app shell/static assets
  (`nysiris-shell-v1`, `nysiris-runtime-v1`); mixnet requests never pass through
  it. "Restart cleanly" removes those caches without deleting app data.
