/**
 * HTTP Range helpers for the media bridge.
 *
 * The service worker and the app must agree on exactly what a Range header
 * means. These functions are pure so `node --test` covers suffix ranges,
 * clamping, and Content-Range formatting without a browser.
 */

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end: number;
}

/**
 * Parse `bytes=start-end`, `bytes=start-`, or `bytes=-suffix`.
 * Returns null for malformed/unsatisfiable ranges; callers answer 416.
 */
export function parseRangeHeader(value: string | null | undefined, total: number | null): ByteRange | null {
  const raw = String(value ?? '').trim();
  if (!raw || !Number.isFinite(total ?? NaN) || total === null || total < 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match) return null;
  const startRaw = match[1];
  const endRaw = match[2];
  if (!startRaw && !endRaw) return null;
  if (total === 0) return null;

  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }
  const start = Number(startRaw);
  if (!Number.isSafeInteger(start) || start >= total) return null;
  const end = endRaw ? Math.min(total - 1, Number(endRaw)) : total - 1;
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end };
}

export function contentRange(start: number, end: number, total: number | null): string {
  return `bytes ${start}-${end}/${total === null ? '*' : total}`;
}

/** Size of an inclusive range, clamped at zero for malformed inputs. */
export function rangeLength(range: ByteRange): number {
  return Math.max(0, range.end - range.start + 1);
}

/** Media elements generally begin with an open-ended range. */
export function initialRange(): ByteRange {
  return { start: 0, end: 0 };
}
