/**
 * Classification for `<object>` / `<embed>` documents.
 *
 * These tags cannot stay live inside the sandboxed document: an `<object>` can
 * load HTML, plugins, or a remote resource without going through the shell.
 * The content loader therefore removes the live element, keeps only a
 * descriptor, and the app renders/fetches the document explicitly.
 *
 * Pure helpers so `node --test` covers the type/extension rules.
 */

export type EmbeddedKind = 'pdf' | 'image' | 'text' | 'media' | 'download' | 'blocked';

export interface EmbeddedDocument {
  id: string;
  kind: EmbeddedKind;
  /** Canonical URL resolved against the page base. */
  url: string;
  contentType: string;
  title: string;
  filename: string;
  /** Why an element was blocked instead of listed as a document. */
  reason?: string;
}

export interface EmbeddedClassification {
  kind: EmbeddedKind;
  contentType: string;
  reason?: string;
}

const BLOCKED_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'application/x-shockwave-flash',
  'application/pdf+html',
]);

const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** Classify an object/embed by declared MIME type, then URL extension. */
export function classifyEmbedded(type: string, url: string): EmbeddedClassification {
  const declared = normaliseType(type);
  const fromUrl = typeFromUrl(url);
  const contentType = declared || fromUrl || 'application/octet-stream';

  if (BLOCKED_TYPES.has(declared)) {
    return {
      kind: 'blocked',
      contentType: declared,
      reason: 'Embedded HTML and plugin content is disabled in the sandbox.',
    };
  }
  if (/^image\//.test(contentType)) return { kind: 'image', contentType };
  if (contentType === 'application/pdf') return { kind: 'pdf', contentType };
  if (/^(audio|video)\//.test(contentType)) return { kind: 'media', contentType };
  if (
    /^text\//.test(contentType) ||
    contentType === 'application/json' ||
    contentType === 'application/xml' ||
    contentType === 'application/javascript'
  ) {
    return { kind: 'text', contentType };
  }
  return { kind: 'download', contentType };
}

/** Safe default filename for a document the server did not name. */
export function embeddedFilename(url: string, title: string, contentType: string): string {
  const cleanTitle = String(title ?? '').trim();
  if (cleanTitle) return cleanTitle.slice(0, 120);
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last).slice(0, 120);
  } catch {
    // Custom schemes that URL still accepts are handled above; fall through.
  }
  const subtype = contentType.split('/')[1]?.split(';')[0] ?? '';
  const extension = subtype === 'octet-stream' ? 'bin' : subtype;
  return `embedded.${extension.replace(/[^a-z0-9]+/gi, '') || 'bin'}`;
}

/** Reject anything that cannot be fetched through the page transport. */
export function isEmbeddedFetchable(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^(nym:\/\/|https?:\/\/)/i.test(url);
}

function normaliseType(value: string): string {
  return String(value ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

function typeFromUrl(url: string): string {
  const path = String(url ?? '').split(/[?#]/)[0];
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension ? (EXTENSION_TYPES[extension] ?? '') : '';
}
