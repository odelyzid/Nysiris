/**
 * Portal object payload schemas.
 *
 * Objects are opaque signed bytes at the provider. The browser only renders
 * kinds it understands, and every payload is parsed fail-closed with explicit
 * size limits. There is deliberately no HTML kind: wiki/feed text is a small
 * Markdown subset rendered by `portalMarkdown.ts`.
 */
import { b64encode, b64decode } from '../lib/bytes.ts';

export const PORTAL_SCHEMA_VERSION = 1;
export const MAX_PORTAL_TITLE = 120;
export const MAX_PORTAL_BODY = 8 * 1024;
export const MAX_PORTAL_BIO = 2 * 1024;
export const MAX_WIKI_PAGES = 64;
export const MAX_PORTAL_LINKS = 64;

export const PORTAL_KINDS = {
  siteIndex: 'site/index',
  profile: 'profile',
  post: 'post',
  wikiPage: 'wiki/page',
  wikiIndex: 'wiki/index',
  object: 'object',
} as const;

export interface SiteIndexContent {
  version: 1;
  title: string;
  description: string;
  pins: string[];
  wiki: WikiPageRef[];
}

export interface ProfileContent {
  version: 1;
  name: string;
  bio: string;
  avatarId: string | null;
}

export interface PostContent {
  version: 1;
  body: string;
  replyTo: string | null;
  attachments: string[];
}

export interface WikiPageContent {
  version: 1;
  slug: string;
  title: string;
  markdown: string;
}

export interface WikiIndexContent {
  version: 1;
  pages: WikiPageRef[];
}

export interface WikiPageRef {
  slug: string;
  title: string;
}

export interface GenericObjectContent {
  version: 1;
  contentType: string;
  name: string;
  dataBase64: string;
}

export type PortalContent =
  SiteIndexContent | ProfileContent | PostContent | WikiPageContent | WikiIndexContent | GenericObjectContent;

/** Encode a payload for `portal-data::Object`; throws when over the kind cap. */
export function encodePortalContent(content: PortalContent): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(content));
  if (bytes.length > 16 * 1024) throw new Error('portal object exceeds the 16 KiB cap');
  return bytes;
}

/** Parse a payload only when the kind is known; null for unknown/invalid. */
export function parsePortalContent(kind: string, payload: Uint8Array): PortalContent | null {
  if (payload.length === 0 || payload.length > 16 * 1024) return null;
  let root: unknown;
  try {
    root = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (!isRecord(root) || root.version !== PORTAL_SCHEMA_VERSION) return null;
  switch (kind) {
    case PORTAL_KINDS.siteIndex:
      return parseSiteIndex(root);
    case PORTAL_KINDS.profile:
      return parseProfile(root);
    case PORTAL_KINDS.post:
      return parsePost(root);
    case PORTAL_KINDS.wikiPage:
      return parseWikiPage(root);
    case PORTAL_KINDS.wikiIndex:
      return parseWikiIndex(root);
    case PORTAL_KINDS.object:
      return parseGenericObject(root);
    default:
      return null;
  }
}

export function portalContentLabel(kind: string): string {
  switch (kind) {
    case PORTAL_KINDS.siteIndex:
      return 'Site index';
    case PORTAL_KINDS.profile:
      return 'Profile';
    case PORTAL_KINDS.post:
      return 'Post';
    case PORTAL_KINDS.wikiPage:
      return 'Wiki page';
    case PORTAL_KINDS.wikiIndex:
      return 'Wiki index';
    case PORTAL_KINDS.object:
      return 'Object';
    default:
      return kind;
  }
}

function parseSiteIndex(root: Record<string, unknown>): SiteIndexContent | null {
  const title = text(root.title, MAX_PORTAL_TITLE);
  if (!title) return null;
  const description = text(root.description, MAX_PORTAL_BIO) ?? '';
  const pins = idList(root.pins, MAX_PORTAL_LINKS);
  const wiki = wikiRefs(root.wiki, MAX_WIKI_PAGES);
  if (!pins || !wiki) return null;
  return { version: 1, title, description, pins, wiki };
}

function parseProfile(root: Record<string, unknown>): ProfileContent | null {
  const name = text(root.name, MAX_PORTAL_TITLE);
  if (!name) return null;
  const bio = text(root.bio, MAX_PORTAL_BIO) ?? '';
  const avatarId = root.avatarId === null || root.avatarId === undefined ? null : id(root.avatarId);
  if (root.avatarId !== null && root.avatarId !== undefined && !avatarId) return null;
  return { version: 1, name, bio, avatarId };
}

function parsePost(root: Record<string, unknown>): PostContent | null {
  const body = text(root.body, MAX_PORTAL_BODY);
  if (!body) return null;
  const replyTo = root.replyTo === null || root.replyTo === undefined ? null : id(root.replyTo);
  if (root.replyTo !== null && root.replyTo !== undefined && !replyTo) return null;
  const attachments = idList(root.attachments, MAX_PORTAL_LINKS);
  if (!attachments) return null;
  return { version: 1, body, replyTo, attachments };
}

function parseWikiPage(root: Record<string, unknown>): WikiPageContent | null {
  const slug = slugValue(root.slug);
  const title = text(root.title, MAX_PORTAL_TITLE);
  const markdown = text(root.markdown, 12 * 1024);
  if (!slug || !title || markdown === null) return null;
  return { version: 1, slug, title, markdown };
}

function parseWikiIndex(root: Record<string, unknown>): WikiIndexContent | null {
  const pages = wikiRefs(root.pages, MAX_WIKI_PAGES);
  return pages ? { version: 1, pages } : null;
}

function parseGenericObject(root: Record<string, unknown>): GenericObjectContent | null {
  const contentType = text(root.contentType, 120);
  const name = text(root.name, MAX_PORTAL_TITLE);
  const encoded = typeof root.dataBase64 === 'string' ? root.dataBase64 : '';
  if (!contentType || !name || !encoded) return null;
  let bytes: Uint8Array;
  try {
    bytes = b64decode(encoded);
  } catch {
    return null;
  }
  if (bytes.length > 12 * 1024) return null;
  return { version: 1, contentType, name, dataBase64: b64encode(bytes) };
}

function wikiRefs(value: unknown, limit: number): WikiPageRef[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) return null;
  const out: WikiPageRef[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) return null;
    const slug = slugValue(item.slug);
    const title = text(item.title, MAX_PORTAL_TITLE);
    if (!slug || !title || seen.has(slug)) return null;
    seen.add(slug);
    out.push({ slug, title });
  }
  return out;
}

function idList(value: unknown, limit: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) return null;
  const out: string[] = [];
  for (const item of value) {
    const clean = id(item);
    if (!clean) return null;
    out.push(clean);
  }
  return out;
}

function text(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  if (!clean || clean.length > limit) return null;
  return clean;
}

function id(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
}

function slugValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug) ? slug : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
