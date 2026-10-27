/**
 * Download shelf metadata.
 *
 * Bytes are saved to disk immediately; this module only keeps the list of
 * recent downloads (name, source URL, size, status) so the UI can show a shelf
 * and offer "save again" without caching large blobs in localStorage.
 */
import type { StorageLike } from '../lib/storage.ts';

export type DownloadStatus = 'pending' | 'saved' | 'failed';

export interface DownloadRecord {
  id: string;
  name: string;
  url: string;
  contentType: string;
  size: number;
  status: DownloadStatus;
  createdAt: number;
  error?: string;
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

function isRecord(value: unknown): value is DownloadRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<DownloadRecord>;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.name === 'string' &&
    typeof record.url === 'string' &&
    (record.status === 'pending' || record.status === 'saved' || record.status === 'failed') &&
    typeof record.size === 'number' &&
    Number.isFinite(record.size)
  );
}
