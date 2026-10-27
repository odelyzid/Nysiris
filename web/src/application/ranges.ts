/**
 * HTTP range helpers for chunked mixnet responses.
 *
 * `StaticFiles` returns one mixnet-sized chunk at a time with a standard
 * `Content-Range` header (plus `X-Nysiris-Total-Length` for clarity). The
 * browser assembles those chunks into the document/asset the tab asked for.
 * Pure so the parsing and assembly logic is unit-tested.
 */

export interface ContentRange {
  start: number;
  end: number;
  total: number | null;
}

export function parseContentRange(value: unknown): ContentRange | null {
  if (typeof value !== 'string') return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return null;
  if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
  return { start, end, total };
}

/** Total response length, if the service advertised it. */
export function responseTotal(headers: Record<string, string>): number | null {
  const range = parseContentRange(headers['content-range']);
  if (range?.total != null) return range.total;
  const raw = headers['x-nysiris-total-length'];
  if (!raw) return null;
  const total = Number(raw);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

export function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, total - offset);
    if (take <= 0) break;
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  if (offset !== total) throw new Error(`incomplete response: got ${offset} of ${total} bytes`);
  return out;
}
