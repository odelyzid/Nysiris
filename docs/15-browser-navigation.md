# 15. Browser Document, Tabs, and Unified Navigation

**Status:** Phase 1 and Phase 2 are implemented, and the Phase 3 core (redirects,
cookies, range chunking, larger static files) is implemented. Remaining items
are listed in each phase below.

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
portal pages. Subresource loading, scripts, forms, cookies, and a real page
engine are later phases (see §15.7).

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
   fetchNym(address, path, Accept: text/html)   mixnetFetch(url)
        │                                           │
        └─────────────────────┬─────────────────────┘
                              │
             applyPage(tab, token, { status, contentType, body })
                              │
              html → sandboxed iframe; text/json → preformatted
```

Back/forward move `historyIndex` and re-fetch that URL without pushing a new
entry. Reload re-fetches the current URL. Stop increments `navToken` so the
late result is ignored. All state changes are applied by tab id + token.

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
- [ ] `Content-Disposition` filename parsing and a resume-capable downloader.
- [ ] Embedded PDF/object documents and media range streaming.

**Implemented in** `web/src/application/contentLoader.ts`. Fetched documents
are sanitised: scripts, frames, plugins, meta refresh, event handlers, and
external SVG references are removed; every CSS `url(...)`/`@import`, image,
favicon, poster, audio, and video source is routed through the injected fetcher
and replaced with a data URL. Links become `data-nysiris-href` values that the
app shell intercepts and opens in the owning tab. The prepared document also
carries its own restrictive CSP as defence in depth.

**Acceptance (met):** a portal page with local CSS and images renders without
clearnet requests; clicking an in-page link stays in the tab. Scripts, forms,
and embedded PDFs remain deliberately disabled; clearnet cookies are handled by
the Phase 3 jar.

### Phase 3 — HTTP semantics (core implemented)

- [x] Clearnet redirects followed by `mixnetFetch`; the final `Response.url`
      is used as the document base.
- [x] Nym `3xx` + `Location` redirects with a five-hop limit.
- [x] Per-origin cookie jar (domain/path/expiry/secure) wired into clearnet
      requests and `Set-Cookie` responses.
- [x] `Range`/`206` support in `nysiris-sdk` static files.
- [x] `fetchNymFull` reassembles `Content-Range` chunks.
- [x] Static files larger than one mixnet message are served in chunks instead
      of `413`; pages/downloads accept up to 8/32 MiB.
- [ ] Auth UI, redirect-response cookies, cache validators (`ETag`/`If-None-Match`),
      content-encoding, HEAD-driven metadata, and a resumable downloader.
- [ ] Per-in-flight-request cancellation (Stop currently ignores the result but
      does not abort the transport call).

**Implemented in** `web/src/application/cookies.ts`,
`web/src/application/ranges.ts`, `web/src/mixnet/fetchNym.ts`, and
`crates/nysiris-sdk/src/files.rs`.

**Acceptance (met for the core):** a multi-KB static page is served and
rendered; redirects are followed; large static responses are assembled from
range chunks.

### Phase 4 — browser lifecycle

- In-place reconnect (no page reload) and tab restoration after reconnect.
- Error boundary + crash recovery.
- Session restore of tab scroll/position and service worker/offline.
- Permissions, find, zoom, print.
- OS protocol handling (`nym://`) on desktop and Android.

### Phase 5 — portal/Osiris surface

- Portal object/log/wiki renderer and authoring.
- Local-first replica browser, offline reader, background replication.
- Fork/conflict explanation; per-portal identity/trust isolation.
- Multi-portal workspace semantics on top of tabs.

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
| `web/src/application/ranges.ts` | `Content-Range` parsing/chunk assembly |
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
| `web/test/ranges.test.mjs` | `Content-Range` parsing and chunk assembly |

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
