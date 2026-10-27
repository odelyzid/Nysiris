/**
 * Header-level HTTP semantics shared by clearnet and Nym responses.
 *
 * Pure string/`Headers` helpers so `node --test web/test` covers the rules
 * without a browser: cache validators, `Content-Disposition` filenames,
 * redirect classification, and case-insensitive header access (`fetchNym`
 * returns a plain record whose key casing comes from the service).
 */

export type HeaderRecord = Record<string, string>;

/** Lowercase-key copy of a `Headers`, keeping the first value for duplicates. */
export function headersToRecord(headers: Headers | null | undefined): HeaderRecord {
  const out: HeaderRecord = {};
  headers?.forEach((value, key) => {
    const name = key.toLowerCase();
    if (!(name in out)) out[name] = value;
  });
  return out;
}

/** Case-insensitive lookup in a record or `Headers`; '' when absent. */
export function headerValue(headers: HeaderRecord | Headers | null | undefined, name: string): string {
  if (!headers) return '';
  if (headers instanceof Headers) return headers.get(name) ?? '';
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return String(headers[key] ?? '');
  }
  return '';
}

/**
 * Every `Set-Cookie` value on a response. Browsers expose repeats through
 * `getSetCookie()`; older engines collapse them into one comma-joined header,
 * which is ambiguous because `Expires` contains commas, so we only split when
 * the engine gives us the dedicated accessor.
 */
export function readSetCookies(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  const all = withGetter.getSetCookie?.();
  if (Array.isArray(all) && all.length > 0) return all.filter((value) => typeof value === 'string' && value);
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function isNotModifiedStatus(status: number): boolean {
  return status === 304;
}

/** Method and body to use on the next hop, following Fetch redirect rules. */
export function redirectRequest(
  status: number,
  method: string,
  body: BodyInit | null | undefined,
): { method: string; body: BodyInit | null | undefined } {
  const verb = method.toUpperCase();
  if (status === 303 && verb !== 'GET' && verb !== 'HEAD') return { method: 'GET', body: undefined };
  if ((status === 301 || status === 302) && verb === 'POST') return { method: 'GET', body: undefined };
  return { method, body };
}

export function parseContentLength(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const size = Number(value.trim());
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

export interface CacheValidators {
  etag: string | null;
  lastModified: string | null;
}

export function responseValidators(headers: HeaderRecord | Headers | null | undefined): CacheValidators {
  const etag = headerValue(headers, 'etag').trim();
  const lastModified = headerValue(headers, 'last-modified').trim();
  return { etag: etag || null, lastModified: lastModified || null };
}

/** `If-None-Match` / `If-Modified-Since` for one cached document. */
export function conditionalRequestHeaders(validators: Partial<CacheValidators> | null | undefined): HeaderRecord {
  const headers: HeaderRecord = {};
  if (validators?.etag) headers['if-none-match'] = validators.etag;
  if (validators?.lastModified) headers['if-modified-since'] = validators.lastModified;
  return headers;
}

/** RFC 9110 weak comparison, including `*` and comma-separated lists. */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string | null | undefined): boolean {
  if (!ifNoneMatch || !etag) return false;
  const tags = ifNoneMatch
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tags.includes('*')) return true;
  const normalise = (tag: string) => tag.replace(/^W\//i, '').trim();
  const wanted = normalise(etag);
  return tags.some((tag) => normalise(tag) === wanted);
}

export function isRangeRequest(headers: HeaderRecord | Headers | null | undefined): boolean {
  return headerValue(headers, 'range').trim().length > 0;
}

/** `bytes=<start>-` for a resumed transfer. */
export function rangeFrom(start: number): string {
  const safe = Number.isFinite(start) && start > 0 ? Math.floor(start) : 0;
  return `bytes=${safe}-`;
}

export interface ParsedDisposition {
  type: string;
  filename: string | null;
}

/**
 * Parse `Content-Disposition` (RFC 6266). `filename*` wins over `filename`;
 * the result is a basename only, so a server cannot steer the save path.
 */
export function parseContentDisposition(value: string | null | undefined): ParsedDisposition {
  const raw = String(value ?? '').trim();
  if (!raw) return { type: '', filename: null };
  const semi = raw.indexOf(';');
  const type = (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
  const params = semi === -1 ? '' : raw.slice(semi + 1);

  let filename: string | null = null;
  const extended = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/i.exec(params);
  if (extended) filename = decodeExtendedValue(extended[1]);
  if (!filename) {
    const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]+))/i.exec(params);
    if (plain) filename = unquote(plain[1] ?? plain[2] ?? '');
  }
  return { type, filename: cleanFilename(filename) };
}

export function filenameFromDisposition(value: string | null | undefined): string | null {
  return parseContentDisposition(value).filename;
}

function decodeExtendedValue(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  // charset'language'percent-encoded-value
  const parts = value.split("'");
  const encoded = parts.length >= 3 ? parts.slice(2).join("'") : value;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function unquote(value: string): string {
  return value
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\\(["\\])/g, '$1');
}

function cleanFilename(value: string | null): string | null {
  if (!value) return null;
  const base = value.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]+/g, '').trim();
  if (!clean || clean === '.' || clean === '..') return null;
  return clean.slice(0, 180);
}
