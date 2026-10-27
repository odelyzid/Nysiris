/**
 * Clearnet request pipeline: cookie jar + authentication + redirects.
 *
 * `mixnetFetch` is a normal `fetch`-shaped transport, but a browser tab needs
 * three things a plain `fetch` would provide implicitly: cookies set by an
 * *intermediate* redirect response, credentials for a `401`, and the final
 * URL after redirects (the `Response` built by the mix-fetch shim has an empty
 * `url`). This module owns those semantics for both documents and downloads.
 *
 * Everything except the transport is injected, so `node --test web/test`
 * exercises redirects/cookies/auth with a fake fetch.
 */
import type { CookieJar } from './cookies.ts';
import { authScopeFor, parseAuthChallenge, type AuthChallenge, type CredentialStore } from './auth.ts';
import {
  headersToRecord,
  isRedirectStatus,
  readSetCookies,
  redirectRequest,
  type HeaderRecord,
} from './httpHeaders.ts';

export type ClearnetTransport = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClearnetOptions {
  fetch: ClearnetTransport;
  jar?: CookieJar;
  credentials?: CredentialStore;
  /** Redirect hops before giving up (default 10). */
  maxRedirects?: number;
}

export interface ClearnetResult {
  response: Response;
  /** Final request URL after redirects (fragment stripped). */
  url: string;
  redirects: number;
  /** Every `Set-Cookie` applied while following this chain. */
  setCookies: string[];
  /** Present when the final response was a `401` with a challenge. */
  authChallenge: AuthChallenge | null;
  /** True when an `Authorization` header was sent on the final hop. */
  authenticated: boolean;
}

const DEFAULT_MAX_REDIRECTS = 10;

export async function clearnetFetch(
  input: string,
  init: RequestInit = {},
  options: ClearnetOptions,
): Promise<ClearnetResult> {
  const maxRedirects = Math.max(0, options.maxRedirects ?? DEFAULT_MAX_REDIRECTS);
  let current = stripFragment(new URL(input));
  let method = String(init.method ?? 'GET').toUpperCase();
  let body = init.body;
  let redirects = 0;
  const setCookies: string[] = [];
  let authenticated = false;

  for (;;) {
    const headers = normaliseHeaders(init.headers);
    const scope = authScopeFor(current.toString());
    const cookie = options.jar?.headerFor(current.toString()) ?? '';
    if (cookie && !headers.cookie) headers.cookie = cookie;
    if (!headers.authorization && options.credentials) {
      const authorization = options.credentials.authorizationFor(scope);
      if (authorization) headers.authorization = authorization;
    }
    authenticated = Boolean(headers.authorization);

    const response = await options.fetch(current.toString(), {
      ...init,
      method,
      body,
      // Follow redirects ourselves so intermediate Set-Cookie headers are not
      // lost. Transports that ignore `manual` still return the final response;
      // in that case there is nothing extra to capture and we return it.
      redirect: 'manual',
      headers,
    } as RequestInit);

    const responseCookies = readSetCookies(response.headers);
    if (responseCookies.length > 0 && options.jar) {
      for (const value of responseCookies) options.jar.setFromHeader(current.toString(), value);
      setCookies.push(...responseCookies);
    }

    const location = response.headers.get('location');
    if (isRedirectStatus(response.status) && location) {
      if (redirects >= maxRedirects) throw new Error(`too many redirects (limit ${maxRedirects})`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error('redirect to an invalid URL');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new Error(`redirect to unsupported URL: ${next.protocol.replace(':', '')}://`);
      }
      const rewritten = redirectRequest(response.status, method, body);
      method = rewritten.method.toUpperCase();
      body = rewritten.body;
      current = stripFragment(next);
      redirects += 1;
      continue;
    }

    const challenge = response.status === 401 ? parseAuthChallenge(response.headers.get('www-authenticate')) : null;
    return {
      response,
      url: response.url || current.toString(),
      redirects,
      setCookies,
      authChallenge: challenge,
      authenticated,
    };
  }
}

/** Lowercase header record from any `RequestInit.headers` shape. */
export function normaliseHeaders(input: HeadersInit | undefined): HeaderRecord {
  const headers = new Headers(input);
  return headersToRecord(headers);
}

function stripFragment(url: URL): URL {
  const copy = new URL(url.toString());
  copy.hash = '';
  return copy;
}
