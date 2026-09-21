/**
 * Pure leak-guard decisions.
 *
 * Kept free of browser globals (`window`, `XMLHttpRequest`) so the rules can be
 * tested with `node --test` — no bundler, no npm install, no browser. The
 * browser wiring lives in `leakGuard.ts`.
 *
 * Security section: docs/05-security.md §5.6 (client-side risks, direct-path leak).
 */

/**
 * @param {string} url
 * @param {string} base
 * @returns {string | null} lower-cased hostname, or null if the URL is invalid
 */
export function hostnameOf(url, base) {
  try {
    return new URL(url, base).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 * @param {string} base
 * @param {Set<string>} routedHosts
 * @returns {boolean}
 */
export function isRouted(url, base, routedHosts) {
  const host = hostnameOf(url, base);
  return host !== null && routedHosts.has(host);
}

/**
 * Decide what to do about a request.
 *
 * `block` is only true when the host is routed AND the guard is fail-closed.
 * `leak` is reported regardless, so "no leaks" and "guard not installed" cannot
 * be confused.
 *
 * @param {string} url
 * @param {string} base
 * @param {Set<string>} routedHosts
 * @param {boolean} failClosed
 * @returns {{ leak: boolean, block: boolean }}
 */
export function decideLeak(url, base, routedHosts, failClosed) {
  const leak = isRouted(url, base, routedHosts);
  return { leak, block: leak && failClosed };
}
