/**
 * Leak guard: detect — and optionally block — direct requests to hosts that are
 * supposed to travel through the mixnet.
 *
 * The mixnet path never touches `window.fetch` or `XMLHttpRequest`, so a direct
 * request to a routed host is a bug in application code. `onLeak` logs even
 * when the guard is in log-only mode, so "no leaks" and "guard not installed"
 * cannot be confused.
 *
 * The pure decision logic lives in `routedHosts.mjs` and is unit-tested by
 * `web/test/routedHosts.test.mjs`. Security section: docs/05-security.md §5.6.
 *
 * Known blind spots (cannot be covered from JS): cross-origin iframes, vendor
 * SDKs in their own contexts, `navigator.sendBeacon`, `EventSource`,
 * `<img>`/`<script>` sources, and third-party `WebSocket`s.
 */
import { decideLeak } from './routedHosts.mjs';

export interface LeakGuardOptions {
  routedHosts: Set<string>;
  failClosed: boolean;
  onLeak?: (url: string) => void;
}

let installed = false;

export function installLeakGuard(routedHosts: Set<string>, failClosed: boolean, onLeak?: (url: string) => void): void {
  if (installed) return;
  installed = true;
  const options: LeakGuardOptions = { routedHosts, failClosed, onLeak };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function guardedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const url = input instanceof Request ? input.url : String(input);
    if (check(url, options)) throw new Error(`nym leak guard: blocked direct request to ${url}`);
    return nativeFetch(input as RequestInfo, init);
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function guardedOpen(method: string, url: string | URL, ...rest: unknown[]) {
    const asString = String(url);
    if (check(asString, options)) throw new Error(`nym leak guard: blocked direct request to ${asString}`);
    // @ts-expect-error -- forwarding the full variadic signature.
    return nativeOpen.call(this, method, url, ...rest);
  };
}

function check(url: string, options: LeakGuardOptions): boolean {
  const { leak, block } = decideLeak(url, location.href, options.routedHosts, options.failClosed);
  if (!leak) return false;
  const message = `nym leak guard: direct request to routed host: ${url}`;
  options.onLeak?.(url);
  console.error(message);
  return block;
}
