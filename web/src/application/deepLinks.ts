/**
 * `nym://` launch-link handling for the web, desktop launchers, and Android.
 *
 * The web cannot register a custom scheme by itself, so the operating-system
 * entry points pass the link through one of three channels:
 *
 * * desktop launchers append `?open=<encoded nym:// link>` to the app URL;
 * * Electron posts `{ type: 'nysiris:open', url }` (and also supports `?open=`);
 * * Capacitor emits `appUrlOpen` for an Android `VIEW` intent.
 *
 * This module only parses/validates; navigation stays in `App.tsx`.
 */

export const OPEN_PARAM = 'open';
export const OPEN_MESSAGE = 'nysiris:open';

/** True for an explicit Nym link (the only external scheme we accept here). */
export function isNymDeepLink(value: unknown): value is string {
  return typeof value === 'string' && /^nym:\/\/\S+/i.test(value.trim());
}

/** Extract `?open=nym://…` / `#open=…` / `#nym=…`; null when absent/invalid. */
export function extractDeepLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(String(url), 'https://local.invalid/');
  } catch {
    return null;
  }
  const candidates = [
    parsed.searchParams.get(OPEN_PARAM),
    new URLSearchParams(parsed.hash.replace(/^#/, '')).get(OPEN_PARAM),
    new URLSearchParams(parsed.hash.replace(/^#/, '')).get('nym'),
  ];
  for (const candidate of candidates) {
    const decoded = safeDecode(candidate ?? '').trim();
    if (isNymDeepLink(decoded)) return decoded.slice(0, 4096);
  }
  return null;
}

/** Remove the one-shot `open` parameter from the visible URL. */
export function stripDeepLink(url: string): string {
  try {
    const parsed = new URL(String(url), 'https://local.invalid/');
    parsed.searchParams.delete(OPEN_PARAM);
    if (parsed.hash.startsWith('#') && parsed.hash.length > 1) {
      const params = new URLSearchParams(parsed.hash.slice(1));
      if (params.has('open') || params.has('nym')) {
        params.delete('open');
        params.delete('nym');
        const hash = params.toString();
        parsed.hash = hash ? `#${hash}` : '';
      }
    }
    return parsed.toString();
  } catch {
    return String(url);
  }
}

/** Build the app URL a desktop launcher should open. */
export function withOpenLink(baseUrl: string, link: string): string {
  const target = isNymDeepLink(link) ? link.trim() : '';
  try {
    const parsed = new URL(baseUrl);
    if (target) parsed.searchParams.set(OPEN_PARAM, target);
    return parsed.toString();
  } catch {
    return baseUrl;
  }
}

/** Accept `--open nym://…` / a bare positional link from native argv. */
export function deepLinkFromArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] ?? '');
    if (arg === '--open') {
      const next = args[i + 1];
      if (isNymDeepLink(next)) return next.trim();
      continue;
    }
    if (arg.startsWith('--open=') && isNymDeepLink(arg.slice('--open='.length))) {
      return arg.slice('--open='.length).trim();
    }
    if (isNymDeepLink(arg)) return arg.trim();
  }
  return null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
