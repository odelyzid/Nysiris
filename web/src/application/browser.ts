/**
 * Browser document/tab model.
 *
 * Pure state transitions for tabs, navigation history, async result guards,
 * and persistence. No React, DOM, or network code lives here, so the entire
 * lifecycle is covered by `node --test web/test`.
 *
 * The app owns one `BrowserTab` per tab. A page body lives in memory only;
 * persistence keeps URLs/titles/history so a reload restores the session
 * without re-fetching every tab.
 */
import type { StorageLike } from '../lib/storage.ts';
import type { NavigationTarget } from './navigation.ts';

export type PageKind = 'html' | 'text' | 'json';

export interface PageContent {
  kind: PageKind;
  contentType: string;
  body: string;
}

export interface BrowserTab {
  id: string;
  kind: 'nym' | 'clearnet' | null;
  /** Canonical URL shown in the address bar. Empty for a blank tab. */
  url: string;
  /** Nym service address or clearnet origin. */
  address: string;
  /** Request path (+ query for clearnet). */
  path: string;
  /** Nym service used to bind Social; empty for clearnet/blank tabs. */
  service: string;
  title: string;
  content: PageContent | null;
  status: number | null;
  error: string | null;
  loading: boolean;
  /** Canonical URLs only, oldest first. */
  history: string[];
  historyIndex: number;
  /** Monotonic guard: stale async results are ignored. */
  navToken: number;
}

export interface PageResult {
  status: number;
  contentType: string;
  body: string;
}

export interface NavigateOptions {
  /** Push a new history entry (default true). */
  push?: boolean;
  /** Token from the navigation that requested this load. */
  token: number;
  /** For back/forward: the already-computed history index. */
  historyIndex?: number;
}

export const MAX_TABS = 12;
export const MAX_HISTORY = 50;
export const BROWSER_TABS_KEY = 'fly.browser.tabs.v1';

let tabSequence = 0;

/** Browser-safe unique tab id (also available in node tests). */
export function newTabId(): string {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === 'function') return `tab-${uuid.call(globalThis.crypto)}`;
  tabSequence += 1;
  return `tab-${Date.now().toString(36)}-${tabSequence.toString(36)}`;
}

export function newBrowserTab(id: string): BrowserTab {
  return {
    id,
    kind: null,
    url: '',
    address: '',
    path: '',
    service: '',
    title: '',
    content: null,
    status: null,
    error: null,
    loading: false,
    history: [],
    historyIndex: -1,
    navToken: 0,
  };
}

/** Move a tab to a target, optionally pushing history. */
export function navigateTab(tab: BrowserTab, target: NavigationTarget, options: NavigateOptions): BrowserTab {
  let history = tab.history.slice();
  let index = tab.historyIndex;
  const sameDocument = tab.url === target.url;

  if (options.push ?? true) {
    history = history.slice(0, Math.max(index + 1, 0));
    if (history[history.length - 1] !== target.url) history.push(target.url);
    index = history.length - 1;
    if (history.length > MAX_HISTORY) {
      const drop = history.length - MAX_HISTORY;
      history = history.slice(drop);
      index -= drop;
    }
  } else if (typeof options.historyIndex === 'number') {
    index = Math.max(0, Math.min(options.historyIndex, history.length - 1));
  } else if (history[index] !== target.url) {
    // A programmatic load that is not in the stack replaces the current entry.
    if (index >= 0 && index < history.length) history[index] = target.url;
    else {
      history = [target.url];
      index = 0;
    }
  }

  return {
    ...tab,
    kind: target.kind,
    url: target.url,
    address: target.address,
    path: target.path,
    // Bind Social only after the page actually arrives (see `applyPage`).
    // Reloading the same document keeps its existing binding.
    service: sameDocument && target.kind === 'nym' ? tab.service : '',
    // Keep the old title/content while reloading the same document; clear
    // them when navigating elsewhere so a slow load cannot show stale content.
    title: sameDocument ? tab.title : '',
    content: sameDocument ? tab.content : null,
    status: sameDocument ? tab.status : null,
    error: null,
    loading: true,
    history,
    historyIndex: index,
    navToken: options.token,
  };
}

/** Apply a successful response only if it belongs to the current navigation. */
export function applyPage(tab: BrowserTab, token: number, result: PageResult): BrowserTab {
  if (tab.navToken !== token) return tab;
  const kind = contentKind(result.contentType, result.body);
  return {
    ...tab,
    content: { kind, contentType: result.contentType, body: result.body },
    status: result.status,
    title: titleFromContent(kind, result.body) || tab.title,
    // A successful Nym navigation binds the community client to this tab.
    service: tab.kind === 'nym' ? tab.address : '',
    error: null,
    loading: false,
  };
}

/** Apply a failed navigation only if it belongs to the current navigation. */
export function failPage(tab: BrowserTab, token: number, message: string): BrowserTab {
  if (tab.navToken !== token) return tab;
  return { ...tab, loading: false, error: message, status: null };
}

/** Cancel the in-flight load; its eventual response is ignored by token. */
export function stopPage(tab: BrowserTab): BrowserTab {
  return { ...tab, loading: false, navToken: tab.navToken + 1 };
}

export function canGoBack(tab: BrowserTab | null): boolean {
  return Boolean(tab && tab.historyIndex > 0);
}

export function canGoForward(tab: BrowserTab | null): boolean {
  return Boolean(tab && tab.history.length > 0 && tab.historyIndex < tab.history.length - 1);
}

/** Resolve one history step without fetching; null at either end. */
export function historyEntry(tab: BrowserTab, delta: number): { url: string; index: number } | null {
  const index = tab.historyIndex + delta;
  if (index < 0 || index >= tab.history.length) return null;
  return { url: tab.history[index], index };
}

/** Close a tab and choose a neighbour. Always leaves at least one blank tab. */
export function closeBrowserTab(
  tabs: BrowserTab[],
  id: string,
  activeId: string,
  makeId: () => string = newTabId,
): { tabs: BrowserTab[]; activeId: string } {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return { tabs, activeId };
  const next = tabs.filter((tab) => tab.id !== id);
  if (next.length === 0) {
    const blank = newBrowserTab(makeId());
    return { tabs: [blank], activeId: blank.id };
  }
  if (activeId !== id) return { tabs: next, activeId };
  const neighbour = next[Math.min(index, next.length - 1)];
  return { tabs: next, activeId: neighbour.id };
}

/** Add a blank tab, capped at MAX_TABS. */
export function addBlankTab(
  tabs: BrowserTab[],
  makeId: () => string = newTabId,
): { tabs: BrowserTab[]; tab: BrowserTab } {
  if (tabs.length >= MAX_TABS) return { tabs, tab: tabs[tabs.length - 1] };
  const tab = newBrowserTab(makeId());
  return { tabs: [...tabs, tab], tab };
}

/** Short, human tab label. */
export function tabTitle(tab: BrowserTab): string {
  const title = tab.title.trim();
  if (title) return title;
  if (!tab.url) return 'New tab';
  if (tab.kind === 'clearnet') {
    try {
      return new URL(tab.url).hostname || tab.url;
    } catch {
      return tab.url;
    }
  }
  if (tab.address) return `${tab.address.slice(0, 10)}…`;
  return tab.url.replace(/^nym:\/\//, '').slice(0, 24) || 'Portal';
}

export function pageKindFor(contentType: string, body = ''): PageKind {
  return contentKind(contentType, body);
}

function contentKind(contentType: string, body: string): PageKind {
  const type = contentType.toLowerCase();
  if (type.includes('text/html') || type.includes('application/xhtml')) return 'html';
  if (type.includes('json')) return 'json';
  if (!type && /^\s*<(!doctype|html)/i.test(body)) return 'html';
  return 'text';
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#?[a-z0-9]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
}

function titleFromContent(kind: PageKind, body: string): string {
  if (kind !== 'html') return '';
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  if (!match) return '';
  const title = decodeEntities(match[1].replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
  return title.slice(0, 120);
}

/* ------------------------------------------------------------------ storage */

interface StoredTab {
  id: string;
  kind: 'nym' | 'clearnet' | null;
  url: string;
  address: string;
  path: string;
  service: string;
  title: string;
  history: string[];
  historyIndex: number;
}

interface StoredState {
  version: 1;
  activeId: string;
  tabs: StoredTab[];
}

/** Persist tabs/URLs/history (never page bodies). */
export function saveBrowserTabs(storage: StorageLike | null, tabs: BrowserTab[], activeId: string): void {
  try {
    storage?.setItem(BROWSER_TABS_KEY, serializeBrowserTabs(tabs, activeId));
  } catch {
    // Private mode/quota: the session simply doesn't persist.
  }
}

export function serializeBrowserTabs(tabs: BrowserTab[], activeId: string): string {
  const state: StoredState = {
    version: 1,
    activeId,
    tabs: tabs.slice(0, MAX_TABS).map((tab) => ({
      id: tab.id,
      kind: tab.kind,
      url: tab.url,
      address: tab.address,
      path: tab.path,
      service: tab.service,
      title: tab.title,
      history: tab.history.slice(-MAX_HISTORY),
      historyIndex: tab.historyIndex,
    })),
  };
  return JSON.stringify(state);
}

/** Restore a persisted session. Invalid data falls back to one blank tab. */
export function restoreBrowserTabs(
  raw: string | null,
  makeId: () => string = newTabId,
): { tabs: BrowserTab[]; activeId: string } {
  const blank = () => {
    const tab = newBrowserTab(makeId());
    return { tabs: [tab], activeId: tab.id };
  };
  if (!raw) return blank();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return blank();
  }
  if (!parsed || typeof parsed !== 'object') return blank();
  const state = parsed as Partial<StoredState>;
  if (state.version !== 1 || !Array.isArray(state.tabs)) return blank();

  const tabs: BrowserTab[] = [];
  for (const value of state.tabs.slice(0, MAX_TABS)) {
    if (!value || typeof value !== 'object') continue;
    const stored = value as Partial<StoredTab>;
    if (typeof stored.id !== 'string' || !stored.id) continue;
    const url = cleanUrl(stored.url);
    if (stored.url && !url) continue;
    const kind = stored.kind === 'nym' || stored.kind === 'clearnet' ? stored.kind : url ? kindFromUrl(url) : null;
    const history = Array.isArray(stored.history)
      ? stored.history
          .map(cleanUrl)
          .filter((entry): entry is string => Boolean(entry))
          .slice(-MAX_HISTORY)
      : [];
    if (url && !history.includes(url)) history.push(url);
    const rawIndex = typeof stored.historyIndex === 'number' ? stored.historyIndex : history.length - 1;
    const historyIndex = history.length === 0 ? -1 : Math.max(0, Math.min(rawIndex, history.length - 1));
    tabs.push({
      ...newBrowserTab(stored.id),
      kind: history.length > 0 ? kind : null,
      url,
      address: typeof stored.address === 'string' ? stored.address : '',
      path: typeof stored.path === 'string' ? stored.path : '',
      service: kind === 'nym' && typeof stored.service === 'string' ? stored.service : '',
      title: typeof stored.title === 'string' ? stored.title.slice(0, 120) : '',
      history,
      historyIndex,
    });
  }

  if (tabs.length === 0) return blank();
  const activeId =
    typeof state.activeId === 'string' && tabs.some((tab) => tab.id === state.activeId) ? state.activeId : tabs[0].id;
  return { tabs, activeId };
}

export function loadBrowserTabs(
  storage: StorageLike | null,
  makeId: () => string = newTabId,
): { tabs: BrowserTab[]; activeId: string } {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(BROWSER_TABS_KEY) ?? null;
  } catch {
    raw = null;
  }
  return restoreBrowserTabs(raw, makeId);
}

function cleanUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  if (url.length > 4096) return '';
  return /^(nym:\/\/|https?:\/\/)/i.test(url) ? url : '';
}

function kindFromUrl(url: string): 'nym' | 'clearnet' {
  return /^nym:\/\//i.test(url) ? 'nym' : 'clearnet';
}
