/**
 * OS/launcher deep-link bridge.
 *
 * Sources, in order of reliability:
 * * a `?open=nym://…` (or `#open=`) parameter — desktop launchers and PWAs;
 * * Electron's `window.postMessage({ type: OPEN_MESSAGE, url })`;
 * * Capacitor's `appUrlOpen` event on Android (when `@capacitor/app` is
 *   installed in the native project; the dynamic import keeps web builds
 *   working without it).
 */
import {
  OPEN_MESSAGE,
  deepLinkFromArgs,
  extractDeepLink,
  isNymDeepLink,
  stripDeepLink,
} from '../../application/deepLinks';

interface CapacitorAppPlugin {
  addListener(
    event: 'appUrlOpen',
    handler: (event: { url?: string }) => void,
  ): Promise<{ remove: () => void }> | { remove: () => void };
  getLaunchUrl?(): Promise<{ url?: string } | null>;
}

let cachedInitial: string | null | undefined;

/**
 * Consume an initial `?open=` link and remove it from the address bar so a
 * reload does not repeat the navigation. The first result is cached so
 * StrictMode's double render cannot lose the link after stripping the URL.
 */
export function takeInitialDeepLink(): string | null {
  if (cachedInitial !== undefined) return cachedInitial;
  if (typeof window === 'undefined') {
    cachedInitial = null;
    return null;
  }
  const link = extractDeepLink(window.location.href);
  cachedInitial = link;
  if (!link) return null;
  try {
    window.history.replaceState(window.history.state, '', stripDeepLink(window.location.href));
  } catch {
    // History may be unavailable in a sandboxed webview.
  }
  return link;
}

/** Subscribe to links that arrive while the app is already running. */
export function subscribeDeepLinks(handler: (link: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const cleanups: Array<() => void> = [];
  let last = '';
  const deliver = (value: unknown) => {
    const link = typeof value === 'string' ? value.trim() : '';
    if (!isNymDeepLink(link) || link === last) return;
    last = link;
    handler(link);
  };

  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (!data || data.type !== OPEN_MESSAGE) return;
    deliver(data.url);
  };
  window.addEventListener('message', onMessage);
  cleanups.push(() => window.removeEventListener('message', onMessage));

  const onHash = () => {
    deliver(extractDeepLink(window.location.href));
  };
  window.addEventListener('hashchange', onHash);
  cleanups.push(() => window.removeEventListener('hashchange', onHash));

  // Native argv forwarded through the web URL (desktop shells that cannot use
  // postMessage). `takeInitialDeepLink` handles the first one.
  const initialArgs = (window as unknown as { nysirisLaunchArgs?: unknown }).nysirisLaunchArgs;
  if (Array.isArray(initialArgs)) {
    const argLink = deepLinkFromArgs(initialArgs.map(String));
    if (argLink) deliver(argLink);
  }

  void (async () => {
    const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (!cap?.isNativePlatform?.()) return;
    try {
      const mod = (await import('@capacitor/app')) as { App?: CapacitorAppPlugin };
      const app = mod.App;
      if (!app) return;
      const launch = await app.getLaunchUrl?.();
      if (launch?.url) deliver(extractDeepLink(launch.url));
      const listener = await app.addListener('appUrlOpen', (event) => {
        if (event?.url) deliver(extractDeepLink(event.url));
      });
      cleanups.push(() => listener.remove());
    } catch {
      // Plugin not installed: query-string/message sources still work.
    }
  })();

  return () => {
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Ignore listener removal races.
      }
    }
  };
}
