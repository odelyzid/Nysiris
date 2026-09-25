/**
 * Primary navigation for the calm client.
 *
 * Pure logic (no browser globals required): storage is injected so this is
 * unit-testable with `node --test web/test`. The app passes `localStorage`
 * via `defaultViewStorage()`.
 *
 * This sits *above* the legacy windowed panels (`panels.ts`): views are the
 * everyday IA (Home / Messages / Portal / Settings); the old technical
 * panels live inside Settings → Advanced and keep their own persistence.
 */

export type ViewId = 'home' | 'messages' | 'portal' | 'service' | 'settings';

export const VIEW_META: Record<ViewId, { title: string; blurb: string }> = {
  home: { title: 'Home', blurb: 'Status and getting started' },
  messages: { title: 'Messages', blurb: 'Private conversations' },
  portal: { title: 'Portal', blurb: 'Private sites and community' },
  service: { title: 'Service', blurb: 'Run your own portal over the mixnet' },
  settings: { title: 'Settings', blurb: 'Your app and advanced tools' },
};

export const VIEW_ORDER: ViewId[] = ['home', 'messages', 'portal', 'service', 'settings'];

export interface ViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const VIEW_KEY = 'fly.view.active';
const ADVANCED_KEY = 'fly.view.advanced';
const ONBOARDED_KEY = 'fly.view.onboarded';

function isViewId(value: unknown): value is ViewId {
  return typeof value === 'string' && value in VIEW_META;
}

/** Which view was active last time. Falls back to `home`. */
export function loadActiveView(storage?: ViewStorage | null): ViewId {
  try {
    const raw = storage?.getItem(VIEW_KEY);
    if (isViewId(raw)) return raw;
    if (!raw) return 'home';
    const parsed: unknown = JSON.parse(raw);
    if (isViewId(parsed)) return parsed;
    return 'home';
  } catch {
    return 'home';
  }
}

export function saveActiveView(view: ViewId, storage?: ViewStorage | null): void {
  try {
    storage?.setItem(VIEW_KEY, view);
  } catch {
    // Private mode: the view just resets next load.
  }
}

/** Advanced (technical tools) is hidden by default and opt-in. */
export function loadAdvancedVisible(storage?: ViewStorage | null): boolean {
  try {
    return storage?.getItem(ADVANCED_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveAdvancedVisible(visible: boolean, storage?: ViewStorage | null): void {
  try {
    storage?.setItem(ADVANCED_KEY, visible ? '1' : '0');
  } catch {
    // Private mode: Advanced just resets to hidden next load (the safe default).
  }
}

/** First-run onboarding is shown until explicitly completed/dismissed. */
export function loadOnboarded(storage?: ViewStorage | null): boolean {
  try {
    return storage?.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveOnboarded(done: boolean, storage?: ViewStorage | null): void {
  try {
    storage?.setItem(ONBOARDED_KEY, done ? '1' : '0');
  } catch {
    // Private mode: onboarding just shows again next load.
  }
}

/** `localStorage` when it exists, otherwise null (SSR/tests/workers). */
export function defaultViewStorage(): ViewStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}
