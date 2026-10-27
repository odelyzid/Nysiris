/**
 * Browser zoom model.
 *
 * Zoom is a presentation preference, not document state, so it lives outside
 * the tab model. Chromium supports the CSS `zoom` property (the launcher and
 * Android shell both use Chromium), which keeps inlined `data:` resources and
 * media sized consistently without rewriting the document.
 */
import type { StorageLike } from '../lib/storage.ts';

export const ZOOM_KEY = 'fly.browser.zoom.v1';
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2;
export const DEFAULT_ZOOM = 1;

/** Readable, deterministic steps; buttons and Ctrl +/- move through these. */
export const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export function clampZoom(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(numeric * 100) / 100));
}

/** Next step in `direction`, clamped at the ends. */
export function nextZoom(current: number, direction: 1 | -1): number {
  const value = clampZoom(current);
  if (direction > 0) return ZOOM_STEPS.find((step) => step > value + 0.001) ?? MAX_ZOOM;
  const lower = [...ZOOM_STEPS].reverse().find((step) => step < value - 0.001);
  return lower ?? MIN_ZOOM;
}

export function zoomLabel(value: number): string {
  return `${Math.round(clampZoom(value) * 100)}%`;
}

export function loadZoom(storage: StorageLike | null): number {
  try {
    return clampZoom(storage?.getItem(ZOOM_KEY) ?? DEFAULT_ZOOM);
  } catch {
    return DEFAULT_ZOOM;
  }
}

export function saveZoom(storage: StorageLike | null, value: number): void {
  try {
    storage?.setItem(ZOOM_KEY, String(clampZoom(value)));
  } catch {
    // Private mode: zoom just resets next load.
  }
}
