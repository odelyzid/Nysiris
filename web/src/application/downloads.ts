/**
 * Download shelf metadata.
 *
 * Bytes are saved to disk immediately; this module only keeps the list of
 * recent downloads (name, source URL, size, status) so the UI can show a shelf
 * and offer "save again" without caching large blobs in localStorage.
 */
import type { StorageLike } from '../lib/storage.ts';

export type DownloadStatus = 'pending' | 'partial' | 'saved' | 'failed';

export interface DownloadRecord {
  id: string;
  name: string;
  url: string;
  contentType: string;
  size: number;
  status: DownloadStatus;
  createdAt: number;
  error?: string;
  /** Bytes already received (kept in memory for a resumed transfer). */
  received?: number;
  /** Total advertised by HEAD/Content-Range, when known. */
  total?: number | null;
  /** Validator used for a resumable `If-Range` request. */
  etag?: string | null;
}

export const DOWNLOADS_KEY = 'fly.browser.downloads.v1';
export const MAX_DOWNLOADS = 50;

let sequence = 0;

export function newDownloadId(): string {
  sequence += 1;
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === 'function') return `dl-${uuid.call(globalThis.crypto)}`;
  return `dl-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export function loadDownloads(storage: StorageLike | null): DownloadRecord[] {
  try {
    const raw = storage?.getItem(DOWNLOADS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord).slice(0, MAX_DOWNLOADS);
  } catch {
    return [];
  }
}

export function saveDownloads(storage: StorageLike | null, entries: DownloadRecord[]): void {
  try {
    storage?.setItem(DOWNLOADS_KEY, JSON.stringify(entries.slice(0, MAX_DOWNLOADS)));
  } catch {
    // Quota/private mode: shelf metadata just doesn't persist.
  }
}

export function addDownload(entries: DownloadRecord[], record: DownloadRecord): DownloadRecord[] {
  return [record, ...entries.filter((entry) => entry.id !== record.id)].slice(0, MAX_DOWNLOADS);
}

export function updateDownload(
  entries: DownloadRecord[],
  id: string,
  patch: Partial<Omit<DownloadRecord, 'id'>>,
): DownloadRecord[] {
  return entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
}

export function removeDownload(entries: DownloadRecord[], id: string): DownloadRecord[] {
  return entries.filter((entry) => entry.id !== id);
}

export function clearDownloads(): DownloadRecord[] {
  return [];
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 0–1 when both progress values are known, else null. */
export function downloadProgress(entry: DownloadRecord): number | null {
  const total = entry.total ?? 0;
  const received = entry.received ?? 0;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(1, received / total));
}

/** A failed/partial record with received bytes can continue with Range. */
export function isResumable(entry: DownloadRecord): boolean {
  return (entry.status === 'partial' || entry.status === 'failed') && Boolean(entry.url) && (entry.received ?? 0) > 0;
}

function isRecord(value: unknown): value is DownloadRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<DownloadRecord>;
  const validStatus =
    record.status === 'pending' ||
    record.status === 'partial' ||
    record.status === 'saved' ||
    record.status === 'failed';
  const validProgress =
    (record.received === undefined || (typeof record.received === 'number' && Number.isFinite(record.received))) &&
    (record.total === undefined ||
      record.total === null ||
      (typeof record.total === 'number' && Number.isFinite(record.total))) &&
    (record.etag === undefined || record.etag === null || typeof record.etag === 'string');
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.name === 'string' &&
    typeof record.url === 'string' &&
    validStatus &&
    typeof record.size === 'number' &&
    Number.isFinite(record.size) &&
    validProgress
  );
}
