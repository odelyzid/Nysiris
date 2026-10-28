/**
 * Media sessions shared by the app-side bridge, `MediaView`, and `PdfView`.
 *
 * A session maps a random token to the canonical document URL and metadata.
 * The service worker only ever sees the token; the app resolves it back to the
 * mixnet/clearnet range fetcher.
 */
import { serviceWorkerSupported } from '../pwa.ts';
import type { HeaderRecord } from '../application/httpHeaders.ts';

export interface MediaDescriptor {
  url: string;
  contentType: string;
  /** Total bytes when HEAD/Content-Range already told us. */
  total: number | null;
  etag: string | null;
  title: string;
}

export interface MediaSession extends MediaDescriptor {
  token: string;
  createdAt: number;
}

export const MEDIA_PATH_PREFIX = '/__nysiris-media/';

export class MediaSessionRegistry {
  private readonly sessions = new Map<string, MediaSession>();
  private readonly makeToken: () => string;
  private readonly now: () => number;

  constructor(options: { makeToken?: () => string; now?: () => number } = {}) {
    this.makeToken = options.makeToken ?? defaultToken;
    this.now = options.now ?? (() => Date.now());
  }

  register(descriptor: MediaDescriptor, token?: string): MediaSession {
    const chosen = token ?? this.makeToken();
    const session: MediaSession = { ...descriptor, token: chosen, createdAt: this.now() };
    this.sessions.set(chosen, session);
    return session;
  }

  get(token: string): MediaSession | null {
    return this.sessions.get(String(token ?? '')) ?? null;
  }

  unregister(token: string): void {
    this.sessions.delete(String(token ?? ''));
  }

  clear(): void {
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** Process-wide registry (one app instance). */
export const mediaSessions = new MediaSessionRegistry();

export function mediaPath(token: string): string {
  return `${MEDIA_PATH_PREFIX}${encodeURIComponent(token)}`;
}

/** True when the worker can intercept a same-origin media path right now. */
export function mediaStreamingAvailable(): boolean {
  try {
    return serviceWorkerSupported() && Boolean(navigator.serviceWorker.controller);
  } catch {
    return false;
  }
}

/** URL-extension hint used to avoid buffering obvious media before a HEAD probe. */
const STREAMABLE_EXTENSION = /\.(mp4|webm|mov|m4v|mp3|ogg|oga|opus|wav|m4a|flac|pdf)(?:[?#]|$)/i;

export function looksLikeStreamableUrl(url: string): boolean {
  return STREAMABLE_EXTENSION.test(String(url ?? ''));
}

export function isStreamableContentType(contentType: string): boolean {
  const type = String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return type.startsWith('audio/') || type.startsWith('video/') || type === 'application/pdf';
}

export interface MediaRangeRequest {
  start: number;
  end: number | null;
  etag: string | null;
}

export interface MediaRangeResponse {
  status: number;
  headers: HeaderRecord;
  body: Uint8Array;
}

function defaultToken(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID().replace(/-/g, '');
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}
