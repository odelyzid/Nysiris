/**
 * Page content loader.
 *
 * Phase 2 of `docs/15-browser-navigation.md`: turn a fetched HTML document into
 * a self-contained document that can render inside the sandboxed viewer.
 *
 * The mixnet gives us one request/one response, so a browser-style renderer
 * cannot let the iframe resolve relative URLs itself: those requests would go
 * to the local origin (or straight to the clearnet) instead of through the
 * mixnet. We therefore fetch the resources the page advertises through the
 * same transport and inline them:
 *
 * * stylesheets (`<link rel=stylesheet>`, `<style>`, inline `style=`)
 * * images (`<img>`, `input[type=image]`, CSS `url(...)`)
 *
 * Scripts, frames, plugins, media, meta refresh, and external link targets are
 * removed or made inert. Links are rewritten to `data-nysiris-href` so the app
 * shell can intercept clicks and navigate the owning tab.
 *
 * Limits are deliberate: a portal cannot make the client fetch an unbounded
 * graph, and the whole prepared document stays bounded in memory. Missing or
 * oversized resources become a transparent pixel rather than a live URL.
 */
import { b64encode } from '../lib/bytes.ts';

export type ResourceKind = 'stylesheet' | 'image' | 'media' | 'other';

export interface ResourceResponse {
  status: number;
  contentType: string;
  bytes: Uint8Array;
}

export type ResourceFetcher = (
  url: string,
  kind: ResourceKind,
  signal?: AbortSignal,
) => Promise<ResourceResponse | null>;

export interface ResourceLoader {
  load(url: string, kind: ResourceKind): Promise<ResourceResponse | null>;
}

export interface LoadStats {
  resources: number;
  bytes: number;
  failed: number;
  truncated: boolean;
}

export interface PrepareOptions {
  maxResources?: number;
  maxResourceBytes?: number;
  maxTotalBytes?: number;
  maxCssDepth?: number;
  /** Cancels the resource fan-out for a stopped/abandoned navigation. */
  signal?: AbortSignal;
}

export interface PreparedDocument {
  html: string;
  title: string;
  /** Inline data URL for the declared icon (or a clearnet `/favicon.ico`). */
  favicon: string | null;
  baseUrl: string;
  stats: LoadStats;
}

export const DEFAULT_MAX_RESOURCES = 24;
export const DEFAULT_MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_CSS_DEPTH = 2;

const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
const ACTIVE_TAGS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'track',
  'portal',
  'fencedframe',
  'bgsound',
  // Declarative shadow DOM would hide links from the parent click handler.
  'template',
];

/** Fetch a resource with budget + deduplication. */
export function createResourceLoader(
  fetcher: ResourceFetcher,
  options: PrepareOptions = {},
): ResourceLoader & {
  readonly stats: LoadStats;
} {
  const maxResources = options.maxResources ?? DEFAULT_MAX_RESOURCES;
  const maxResourceBytes = options.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const cache = new Map<string, Promise<ResourceResponse | null>>();
  const stats: LoadStats = { resources: 0, bytes: 0, failed: 0, truncated: false };

  return {
    get stats() {
      return { ...stats };
    },
    load(url: string, kind: ResourceKind): Promise<ResourceResponse | null> {
      if (options.signal?.aborted) return Promise.resolve(null);
      const cached = cache.get(url);
      if (cached) return cached;
      if (stats.resources >= maxResources) {
        stats.truncated = true;
        return Promise.resolve(null);
      }
      stats.resources += 1;
      const task = (async () => {
        try {
          const response = await fetcher(url, kind, options.signal);
          if (!response || response.status >= 400) {
            stats.failed += 1;
            return null;
          }
          if (response.bytes.length > maxResourceBytes || stats.bytes + response.bytes.length > maxTotalBytes) {
            stats.truncated = true;
            stats.failed += 1;
            return null;
          }
          stats.bytes += response.bytes.length;
          return response;
        } catch {
          stats.failed += 1;
          return null;
        }
      })();
      cache.set(url, task);
      return task;
    },
  };
}

/**
 * Prepare fetched HTML for the sandboxed viewer.
 *
 * `baseUrl` is the canonical page URL (`nym://…` or `https://…`); relative
 * resources and links resolve against it. `fetchResource` is expected to route
 * through `fetchNym`/`mixnetFetch`, never native `fetch`.
 */
export async function prepareDocument(
  html: string,
  baseUrl: string,
  fetchResource: ResourceFetcher,
  options: PrepareOptions = {},
): Promise<PreparedDocument> {
  const loader = createResourceLoader(fetchResource, options);
  const maxCssDepth = options.maxCssDepth ?? DEFAULT_MAX_CSS_DEPTH;
  const parsed = parseHtml(html);
  if (!parsed) {
    return {
      html: `<pre>${escapeHtml(html.slice(0, 200_000))}</pre>`,
      title: '',
      favicon: null,
      baseUrl,
      stats: loader.stats,
    };
  }
  const { doc } = parsed;

  for (const element of [...doc.querySelectorAll(ACTIVE_TAGS.join(','))]) element.remove();
  for (const meta of [...doc.querySelectorAll('meta[http-equiv]')]) {
    const equiv = (meta.getAttribute('http-equiv') ?? '').toLowerCase();
    // Refresh can navigate the frame; a page-level CSP would block the
    // self-contained data: assets we just built. The parent CSP still applies.
    if (equiv === 'refresh' || equiv === 'content-security-policy') meta.remove();
  }
  for (const element of [...doc.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith('on') ||
        name === 'srcdoc' ||
        name === 'ping' ||
        name === 'integrity' ||
        name === 'nonce' ||
        name === 'formaction'
      ) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.hasAttribute('background')) element.removeAttribute('background');
    if (element.hasAttribute('srcset')) element.removeAttribute('srcset');
    if (element.hasAttribute('imagesrcset')) element.removeAttribute('imagesrcset');
    // Obsolete loaders that some engines still honour.
    for (const name of ['lowsrc', 'dynsrc']) element.removeAttribute(name);
  }

  // Favicons are fetched before the non-stylesheet `<link>` cleanup below.
  let favicon: string | null = null;
  for (const link of [...doc.querySelectorAll('link[rel]')]) {
    if (favicon) break;
    const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    if (!rel.some((value) => value === 'icon' || value.endsWith('-icon'))) continue;
    const href = link.getAttribute('href');
    const absolute = href ? resolveResourceUrl(href, baseUrl) : null;
    if (!absolute) continue;
    if (absolute.startsWith('data:')) {
      if (/^data:image\//i.test(absolute)) favicon = absolute;
      continue;
    }
    favicon = await inlineImage(absolute, loader);
  }
  if (!favicon && /^https?:/i.test(baseUrl)) {
    // Clearnet browsers silently probe /favicon.ico; do the same through the
    // exit, but only when the page did not declare an icon.
    const absolute = resolveResourceUrl('/favicon.ico', baseUrl);
    if (absolute) favicon = await inlineImage(absolute, loader);
  }
  if (favicon && favicon.length > 200_000) favicon = null;

  // Stylesheets: fetch and inline so no relative URL reaches the browser.
  for (const link of [...doc.querySelectorAll('link')]) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet')) {
      link.remove();
      continue;
    }
    const href = link.getAttribute('href');
    const absolute = href ? resolveResourceUrl(href, baseUrl) : null;
    if (!absolute) {
      link.remove();
      continue;
    }
    const response = await loader.load(absolute, 'stylesheet');
    if (!response) {
      link.remove();
      continue;
    }
    const style = doc.createElement('style');
    if (link.getAttribute('media')) style.setAttribute('media', link.getAttribute('media') ?? '');
    style.textContent = await rewriteCss(decodeText(response.bytes), absolute, loader, 0, maxCssDepth);
    link.replaceWith(style);
  }

  for (const style of [...doc.querySelectorAll('style')]) {
    style.textContent = await rewriteCss(style.textContent ?? '', baseUrl, loader, 0, maxCssDepth);
  }

  for (const element of [...doc.querySelectorAll('[style]')]) {
    const css = element.getAttribute('style') ?? '';
    element.setAttribute('style', await rewriteCss(css, baseUrl, loader, maxCssDepth, maxCssDepth));
  }

  // Images. `srcset` is removed above; only the primary source is inlined.
  for (const image of [...doc.querySelectorAll('img[src], input[type="image"][src]')]) {
    const src = image.getAttribute('src') ?? '';
    const absolute = resolveResourceUrl(src, baseUrl);
    if (!absolute) {
      // Unsupported scheme (`javascript:`, `blob:`, …) must not survive as a
      // live attribute, even though the sandbox also disables scripts.
      image.setAttribute('src', TRANSPARENT_PIXEL);
      continue;
    }
    if (absolute.startsWith('data:')) continue;
    const data = await inlineImage(absolute, loader);
    if (data) image.setAttribute('src', data);
    else image.setAttribute('src', TRANSPARENT_PIXEL);
  }
  // Embedded media. Direct `src` and `<source>` children are inlined under the
  // same budget; poster images go through the image path. `<source>` elements
  // that belong to `<picture>` are left to the image fallback (their srcset was
  // removed above) and are dropped here.
  for (const video of [...doc.querySelectorAll('video[poster]')]) {
    const poster = video.getAttribute('poster') ?? '';
    if (/^data:image\//i.test(poster)) continue;
    const absolute = resolveResourceUrl(poster, baseUrl);
    const data = absolute ? await inlineImage(absolute, loader) : null;
    if (data) video.setAttribute('poster', data);
    else video.removeAttribute('poster');
  }
  for (const media of [...doc.querySelectorAll('video[src], audio[src]')]) {
    const raw = media.getAttribute('src') ?? '';
    if (/^data:(audio|video)\//i.test(raw)) continue;
    const absolute = resolveResourceUrl(raw, baseUrl);
    const data = absolute ? await inlineMedia(absolute, loader) : null;
    if (data) media.setAttribute('src', data);
    else media.removeAttribute('src');
  }
  for (const source of [...doc.querySelectorAll('source')]) {
    const parent = source.parentElement?.tagName.toLowerCase();
    if (parent !== 'video' && parent !== 'audio') {
      source.remove();
      continue;
    }
    const raw = source.getAttribute('src') ?? '';
    if (/^data:(audio|video)\//i.test(raw)) continue;
    const absolute = resolveResourceUrl(raw, baseUrl);
    const data = absolute ? await inlineMedia(absolute, loader) : null;
    if (data) source.setAttribute('src', data);
    else source.remove();
  }
  for (const element of [...doc.querySelectorAll('[src]:not(img):not(input):not(video):not(audio):not(source)')]) {
    element.removeAttribute('src');
  }

  // SVG `<image>` and `<use>` can load external URLs without going through
  // `src`; inline images and drop external symbol references.
  for (const element of [...doc.querySelectorAll('image, feImage, use')]) {
    for (const attribute of ['href', 'xlink:href']) {
      const raw = element.getAttribute(attribute);
      if (!raw || raw.startsWith('#')) continue;
      if (['image', 'feimage'].includes(element.tagName.toLowerCase())) {
        const absolute = resolveResourceUrl(raw, baseUrl);
        const data = absolute ? await inlineImage(absolute, loader) : null;
        if (data) element.setAttribute(attribute, data);
        else element.removeAttribute(attribute);
      } else {
        element.removeAttribute(attribute);
      }
    }
  }

  // Links stay visible but leave the iframe through the app's tab model.
  for (const link of [...doc.querySelectorAll('a')]) {
    const xlink = link.getAttribute('xlink:href');
    if (xlink) {
      link.setAttribute('href', xlink);
      link.removeAttribute('xlink:href');
    }
  }
  for (const link of [...doc.querySelectorAll('a[href], area[href]')]) {
    rewriteLink(link, baseUrl);
  }

  // Forms cannot submit in this sandbox; make that explicit rather than
  // leaving a live-looking action.
  for (const form of [...doc.querySelectorAll('form')]) {
    form.setAttribute('action', '#');
    form.setAttribute('method', 'get');
  }

  // Defense in depth: even if a future shell forgets the sandbox or the parent
  // CSP does not propagate into srcdoc, the prepared document cannot run
  // scripts, submit forms, embed frames, or load a non-inline resource.
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute(
    'content',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; frame-src 'none'; form-action 'none'; base-uri 'none'",
  );
  doc.head.prepend(csp);

  const title = (doc.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return {
    html: `<!doctype html>\n${doc.documentElement.outerHTML}`,
    title,
    favicon,
    baseUrl,
    stats: loader.stats,
  };
}

/**
 * Resolve a resource URL against the page/stylesheet URL. Returns `null` for
 * unsupported schemes; `data:` is passed through unchanged because it is
 * already self-contained.
 */
export function resolveResourceUrl(raw: string, baseUrl: string): string | null {
  const value = String(raw ?? '').trim();
  if (!value || value.startsWith('#')) return null;
  if (/^data:/i.test(value)) return value;
  if (/^(javascript:|mailto:|tel:|blob:|about:)/i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return null;
  }
  return supportedUrl(url) ? url.toString() : null;
}

/**
 * Resolve a link target. Fragments stay inside the document and return null so
 * the caller can leave them untouched.
 */
export function resolveLinkUrl(raw: string, baseUrl: string): string | null {
  const value = String(raw ?? '').trim();
  if (!value || value.startsWith('#')) return null;
  if (/^(javascript:|mailto:|tel:|data:|blob:|about:)/i.test(value)) return null;
  try {
    const url = new URL(value, baseUrl);
    return supportedUrl(url) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite CSS: inline `@import`s (bounded) and replace every `url(...)` with a
 * data URL. Failed assets become a transparent pixel, never a live URL.
 */
export async function rewriteCss(
  css: string,
  styleUrl: string,
  loader: ResourceLoader,
  depth = 0,
  maxDepth = DEFAULT_MAX_CSS_DEPTH,
): Promise<string> {
  let output = css;
  if (depth < maxDepth) output = await inlineImports(output, styleUrl, loader, depth, maxDepth);
  return replaceCssUrls(output, styleUrl, loader);
}

async function inlineImports(
  css: string,
  styleUrl: string,
  loader: ResourceLoader,
  depth: number,
  maxDepth: number,
): Promise<string> {
  const re = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?\s*([^;]*);/gi;
  let result = '';
  let last = 0;
  for (const match of css.matchAll(re)) {
    const index = match.index ?? 0;
    result += css.slice(last, index);
    last = index + match[0].length;
    const absolute = resolveResourceUrl(match[2], styleUrl);
    if (!absolute || depth + 1 > maxDepth) {
      result += '/* nysiris: import skipped */';
      continue;
    }
    const response = await loader.load(absolute, 'stylesheet');
    if (!response) {
      result += '/* nysiris: import unavailable */';
      continue;
    }
    const child = await rewriteCss(decodeText(response.bytes), absolute, loader, depth + 1, maxDepth);
    const media = (match[3] ?? '').trim();
    result += media && !/layer|supports/i.test(media) ? `@media ${media}{${child}}` : child;
  }
  return result + css.slice(last);
}

async function replaceCssUrls(css: string, styleUrl: string, loader: ResourceLoader): Promise<string> {
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let result = '';
  let last = 0;
  for (const match of css.matchAll(re)) {
    const index = match.index ?? 0;
    result += css.slice(last, index);
    last = index + match[0].length;
    const raw = match[2].trim();
    if (/^(data:|#)/i.test(raw)) {
      result += match[0];
      continue;
    }
    const absolute = resolveResourceUrl(raw, styleUrl);
    const data = absolute ? await inlineImage(absolute, loader) : null;
    result += `url("${data ?? TRANSPARENT_PIXEL}")`;
  }
  return result + css.slice(last);
}

async function inlineImage(url: string, loader: ResourceLoader): Promise<string | null> {
  const response = await loader.load(url, 'image');
  if (!response) return null;
  let contentType = normalizeContentType(response.contentType);
  if (!contentType.startsWith('image/')) contentType = imageMimeFromUrl(url);
  if (!contentType.startsWith('image/')) return null;
  return `data:${contentType};base64,${b64encode(response.bytes)}`;
}

async function inlineMedia(url: string, loader: ResourceLoader): Promise<string | null> {
  const response = await loader.load(url, 'media');
  if (!response) return null;
  let contentType = normalizeContentType(response.contentType);
  if (!contentType.startsWith('audio/') && !contentType.startsWith('video/')) {
    contentType = mediaMimeFromUrl(url);
  }
  if (!contentType.startsWith('audio/') && !contentType.startsWith('video/')) return null;
  return `data:${contentType};base64,${b64encode(response.bytes)}`;
}

function rewriteLink(element: Element, baseUrl: string): void {
  const raw = element.getAttribute('href')?.trim() ?? '';
  if (!raw) return;
  if (raw.startsWith('#')) return;
  const absolute = resolveLinkUrl(raw, baseUrl);
  if (!absolute) {
    element.removeAttribute('href');
    return;
  }
  element.setAttribute('data-nysiris-href', absolute);
  element.setAttribute('href', '#');
  element.removeAttribute('target');
  element.removeAttribute('download');
  element.setAttribute('rel', 'noreferrer noopener');
}

function parseHtml(html: string): { doc: Document } | null {
  if (typeof DOMParser === 'undefined') return null;
  try {
    return { doc: new DOMParser().parseFromString(html, 'text/html') };
  } catch {
    return null;
  }
}

function supportedUrl(url: URL): boolean {
  if (url.protocol === 'http:' || url.protocol === 'https:') return true;
  if (url.protocol === 'nym:') {
    // WHATWG parses the part before `@` as userinfo, so `url.host` is only the
    // gateway. Validate the original authority instead.
    const authority = url.href.slice('nym://'.length).split(/[/?#]/, 1)[0];
    return authority.split('@').length === 2;
  }
  return false;
}

function normalizeContentType(value: string): string {
  return String(value ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

function mediaMimeFromUrl(url: string): string {
  const path = url.split('#')[0].split('?')[0].toLowerCase();
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.ogg') || path.endsWith('.oga')) return 'audio/ogg';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.m4a')) return 'audio/mp4';
  if (path.endsWith('.mp4')) return 'video/mp4';
  if (path.endsWith('.webm')) return 'video/webm';
  return '';
}

function imageMimeFromUrl(url: string): string {
  const path = url.split('#')[0].split('?')[0].toLowerCase();
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.avif')) return 'image/avif';
  if (path.endsWith('.ico')) return 'image/x-icon';
  return '';
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
