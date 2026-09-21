/**
 * Tabs for the Portal community section (nysiris).
 *
 * Pure logic (no browser globals required): storage is injected so this is
 * unit-testable with `node --test web/test`. The component passes
 * `localStorage` via `defaultSocialTabStorage()`.
 *
 * Tabs mirror the service's landing page (`DESCRIPTOR_HTML` in
 * `services/social/src/service.rs`): Timeline and Private messages are the
 * everyday views; About holds the profile editor, the service description,
 * and the technical log.
 */

export type SocialTab = 'timeline' | 'messages' | 'about';

export const SOCIAL_TAB_META: Record<SocialTab, { title: string; blurb: string }> = {
  timeline: { title: 'Timeline', blurb: 'Global chronological timeline' },
  messages: { title: 'Private messages', blurb: 'Sealed direct messages' },
  about: { title: 'About', blurb: 'Profiles and how this community works' },
};

export const SOCIAL_TAB_ORDER: SocialTab[] = ['timeline', 'messages', 'about'];

export interface SocialTabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const TAB_KEY = 'fly.social.tab';

function isSocialTab(value: unknown): value is SocialTab {
  return typeof value === 'string' && value in SOCIAL_TAB_META;
}

/** Which community tab was active last time. Falls back to `timeline`. */
export function loadSocialTab(storage?: SocialTabStorage | null): SocialTab {
  try {
    const raw = storage?.getItem(TAB_KEY);
    if (isSocialTab(raw)) return raw;
    return 'timeline';
  } catch {
    return 'timeline';
  }
}

export function saveSocialTab(tab: SocialTab, storage?: SocialTabStorage | null): void {
  try {
    storage?.setItem(TAB_KEY, tab);
  } catch {
    // Private mode: the tab just resets next load.
  }
}

/** `localStorage` when it exists, otherwise null (SSR/tests/workers). */
export function defaultSocialTabStorage(): SocialTabStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}
