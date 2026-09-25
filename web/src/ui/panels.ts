/**
 * Panel registry for the windowed UI.
 *
 * Pure logic (no browser globals required): storage is injected so this is
 * unit-testable with `node --test web/test`. The app passes `localStorage`
 * via `defaultStorage()`.
 */

import { defaultStorage } from '../lib/storage.ts';

export { defaultStorage };

export type PanelId = 'connection' | 'messages' | 'fetch' | 'log' | 'contacts' | 'portal';

export const PANEL_META: Record<PanelId, { title: string }> = {
  connection: { title: 'Connection' },
  messages: { title: 'Messages' },
  fetch: { title: 'Fetch' },
  log: { title: 'Log' },
  contacts: { title: 'Contacts' },
  portal: { title: 'Portal' },
};

export const PANEL_ORDER: PanelId[] = ['connection', 'messages', 'fetch', 'contacts', 'portal', 'log'];

export interface PanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'fly.panels.open';

function isPanelId(value: unknown): value is PanelId {
  return typeof value === 'string' && value in PANEL_META;
}

/** Which panels were open last time. Unknown/malformed entries are dropped. */
export function loadOpenPanels(storage?: PanelStorage | null): PanelId[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPanelId);
  } catch {
    return [];
  }
}

export function saveOpenPanels(open: PanelId[], storage?: PanelStorage | null): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(open));
  } catch {
    // Storage full or unavailable (private mode): panels just reset next load.
  }
}
