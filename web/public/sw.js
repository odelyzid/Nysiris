/* Nysiris app-shell service worker.
 *
 * Scope: app shell + same-origin static assets only. Mixnet traffic runs inside
 * the WASM client and never reaches `fetch`, so it is untouched by this worker.
 * Navigations prefer the network (fresh app shell); assets are served
 * stale-while-revalidate so the shell still starts offline after one visit.
 */
const SHELL_CACHE = 'nysiris-shell-v1';
const RUNTIME_CACHE = 'nysiris-runtime-v1';
const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'nysiris:media-chunk') {
    const pending = mediaPending.get(event.data.requestId);
    if (pending) {
      mediaPending.delete(event.data.requestId);
      pending(event.data);
    }
  }
});

const mediaPending = new Map();

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/sw.js') return;

  if (url.pathname.startsWith('/__nysiris-media/')) {
    event.respondWith(handleMediaRequest(request, url));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

async function handleMediaRequest(request, url) {
  const token = decodeURIComponent(url.pathname.slice('/__nysiris-media/'.length));
  if (!token) return new Response('missing media token', { status: 400 });
  const rangeHeader = request.headers.get('range');
  let start = 0;
  let end = null;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) {
      return new Response('', {
        status: 416,
        headers: { 'content-range': 'bytes */*' },
      });
    }
    // Suffix ranges need the total, which the worker does not know yet. The
    // app answers the first chunk and the media element retries with a total.
    start = match[1] ? Number(match[1]) : 0;
    end = match[2] ? Number(match[2]) : null;
  }

  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clients.length === 0) return new Response('no app window', { status: 503 });
  const reply = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      mediaPending.delete(requestId);
      resolve(null);
    }, 120_000);
    mediaPending.set(requestId, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
    for (const client of clients) {
      client.postMessage({ type: 'nysiris:media-range', requestId, token, start, end });
    }
  });
  if (!reply) return new Response('media request timed out', { status: 504 });

  const headers = new Headers();
  const allowed = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag'];
  for (const name of allowed) {
    const value = reply.headers && reply.headers[name];
    if (typeof value === 'string' && value) headers.set(name, value);
  }
  headers.set('cross-origin-resource-policy', 'same-origin');
  const body = request.method === 'HEAD' ? null : reply.body;
  return new Response(body, { status: reply.status || 200, headers });
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put('/index.html', response.clone()).catch(() => undefined);
    return response;
  } catch {
    return (
      (await cache.match(request)) ||
      (await cache.match('/index.html')) ||
      (await cache.match('/')) ||
      new Response('Offline and no cached app shell is available.', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    );
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone()).catch(() => undefined);
      return response;
    })
    .catch(() => null);
  return cached || (await network) || new Response('', { status: 504 });
}
