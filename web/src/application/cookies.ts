/**
 * Minimal per-origin cookie jar for clearnet pages fetched through the exit.
 *
 * The mixnet transport is a normal `fetch`-shaped API, but browsers do not
 * automatically apply cookies to responses obtained through a worker. This
 * jar keeps the app-level session working: `Cookie` goes out on the next
 * request to a matching origin/path and `Set-Cookie` from a response updates
 * the jar.
 *
 * Deliberately small: host-only/domain/path/expiry/secure are honoured; no
 * Public Suffix List, no partitioned cookies, no third-party isolation. It is
 * a browser-session convenience, not a security boundary.
 */
import type { StorageLike } from '../lib/storage.ts';

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  /** Unix ms, or null for a session cookie. */
  expiresAt: number | null;
  secure: boolean;
}

export const COOKIE_KEY = 'fly.browser.cookies.v1';
export const MAX_COOKIES = 120;
const MAX_COOKIE_VALUE = 4096;

export class CookieJar {
  private cookies: StoredCookie[] = [];
  private readonly now: () => number;

  constructor(cookies: StoredCookie[] = [], now: () => number = () => Date.now()) {
    this.now = now;
    this.cookies = cookies.filter(isCookie).slice(-MAX_COOKIES);
    this.purge();
  }

  /** Cookie header value for a request, or '' when none match. */
  headerFor(url: string): string {
    this.purge();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return '';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const path = parsed.pathname || '/';
    const matches = this.cookies.filter(
      (cookie) =>
        domainMatches(parsed.hostname, cookie.domain, cookie.hostOnly) &&
        pathMatches(path, cookie.path) &&
        (!cookie.secure || parsed.protocol === 'https:'),
    );
    return matches.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  /** Apply one `Set-Cookie` header from `url`. */
  setFromHeader(url: string, header: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    const parts = String(header ?? '').split(';');
    const pair = parts.shift() ?? '';
    const equals = pair.indexOf('=');
    if (equals <= 0) return;
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (!name || name.length > 128 || value.length > MAX_COOKIE_VALUE) return;

    let domain = parsed.hostname.toLowerCase();
    let hostOnly = true;
    let path = defaultPath(parsed.pathname);
    let expiresAt: number | null = null;
    let secure = false;

    for (const attribute of parts) {
      const index = attribute.indexOf('=');
      const key = (index === -1 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
      const val = index === -1 ? '' : attribute.slice(index + 1).trim();
      if (key === 'domain' && val) {
        const candidate = val.replace(/^\./, '').toLowerCase();
        if (!domainMatches(parsed.hostname, candidate, false)) return;
        domain = candidate;
        hostOnly = false;
      } else if (key === 'path' && val.startsWith('/')) {
        path = val;
      } else if (key === 'max-age') {
        const seconds = Number(val);
        if (Number.isFinite(seconds)) expiresAt = this.now() + seconds * 1000;
      } else if (key === 'expires') {
        const when = Date.parse(val);
        if (Number.isFinite(when)) expiresAt = when;
      } else if (key === 'secure') {
        secure = true;
      }
    }

    const next: StoredCookie = { name, value, domain, hostOnly, path, expiresAt, secure };
    this.cookies = this.cookies.filter(
      (cookie) =>
        !(cookie.name === name && cookie.domain === domain && cookie.path === path && cookie.hostOnly === hostOnly),
    );
    if (expiresAt !== null && expiresAt <= this.now()) {
      this.purge();
      return;
    }
    this.cookies.push(next);
    if (this.cookies.length > MAX_COOKIES) this.cookies = this.cookies.slice(-MAX_COOKIES);
  }

  clear(): void {
    this.cookies = [];
  }

  purge(): void {
    const now = this.now();
    this.cookies = this.cookies.filter((cookie) => cookie.expiresAt === null || cookie.expiresAt > now);
  }

  toJSON(): StoredCookie[] {
    this.purge();
    return this.cookies.map((cookie) => ({ ...cookie }));
  }

  get size(): number {
    return this.cookies.length;
  }
}

export function loadCookieJar(storage: StorageLike | null): CookieJar {
  try {
    const raw = storage?.getItem(COOKIE_KEY);
    if (!raw) return new CookieJar();
    const parsed: unknown = JSON.parse(raw);
    return new CookieJar(Array.isArray(parsed) ? (parsed as StoredCookie[]) : []);
  } catch {
    return new CookieJar();
  }
}

export function saveCookieJar(storage: StorageLike | null, jar: CookieJar): void {
  try {
    storage?.setItem(COOKIE_KEY, JSON.stringify(jar.toJSON()));
  } catch {
    // Quota/private mode: the cookie jar is session-only.
  }
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const end = pathname.lastIndexOf('/');
  return end <= 0 ? '/' : pathname.slice(0, end);
}

function domainMatches(host: string, domain: string, hostOnly: boolean): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return hostOnly ? h === d : h === d || h.endsWith(`.${d}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

function isCookie(value: unknown): value is StoredCookie {
  if (!value || typeof value !== 'object') return false;
  const cookie = value as Partial<StoredCookie>;
  return (
    typeof cookie.name === 'string' &&
    cookie.name.length > 0 &&
    typeof cookie.value === 'string' &&
    typeof cookie.domain === 'string' &&
    typeof cookie.path === 'string' &&
    typeof cookie.hostOnly === 'boolean' &&
    typeof cookie.secure === 'boolean' &&
    (cookie.expiresAt === null || typeof cookie.expiresAt === 'number')
  );
}
