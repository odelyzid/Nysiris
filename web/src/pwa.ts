/**
 * PWA/service-worker registration and connectivity helpers.
 *
 * The worker caches the app shell and hashed assets, so the browser can still
 * render a cached document while the network (or the mixnet) is unavailable.
 * Mixnet requests never touch the service worker: they run inside the WASM
 * client, not through `window.fetch`.
 */

export const SERVICE_WORKER_URL = '/sw.js';
export const APP_SHELL_CACHE = 'nysiris-shell-v1';
export const RUNTIME_CACHE = 'nysiris-runtime-v1';

export interface ServiceWorkerStatus {
  supported: boolean;
  registered: boolean;
  controlled: boolean;
  error: string | null;
}

export function serviceWorkerSupported(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  } catch {
    return false;
  }
}

/**
 * Register the shell worker. Safe to call repeatedly; failures are reported,
 * never thrown, because the app must keep working without a worker.
 */
export async function registerServiceWorker(
  options: { url?: string; onUpdate?: () => void } = {},
): Promise<ServiceWorkerStatus> {
  if (!serviceWorkerSupported()) {
    return { supported: false, registered: false, controlled: false, error: null };
  }
  try {
    const registration = await navigator.serviceWorker.register(options.url ?? SERVICE_WORKER_URL, {
      scope: '/',
    });
    registration.addEventListener('updatefound', () => {
      options.onUpdate?.();
    });
    return {
      supported: true,
      registered: true,
      controlled: Boolean(navigator.serviceWorker.controller),
      error: null,
    };
  } catch (err) {
    return {
      supported: true,
      registered: false,
      controlled: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Remove every service worker registration (safe-mode recovery). */
export async function unregisterServiceWorkers(): Promise<number> {
  if (!serviceWorkerSupported()) return 0;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    let removed = 0;
    for (const registration of registrations) {
      if (await registration.unregister()) removed += 1;
    }
    return removed;
  } catch {
    return 0;
  }
}

/** Delete the app-shell/runtime caches (does not touch app storage). */
export async function clearAppShellCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    await Promise.all([caches.delete(APP_SHELL_CACHE), caches.delete(RUNTIME_CACHE)]);
  } catch {
    // Cache API unavailable/private mode.
  }
}

/** Current connectivity; defaults to online when the API is missing. */
export function isOnline(): boolean {
  try {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  } catch {
    return true;
  }
}

/** Subscribe to online/offline transitions; returns an unsubscribe function. */
export function watchConnectivity(listener: (online: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const update = () => listener(isOnline());
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}
