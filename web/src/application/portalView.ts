/**
 * Pure Portal view model.
 *
 * Turns a verified replica into feed/wiki/profile/object collections. Unknown
 * kinds and malformed payloads are counted, never rendered. Trust verdicts are
 * portal-scoped; blocked authors are removed before ordering.
 */
import {
  PORTAL_KINDS,
  parsePortalContent,
  type PortalContent,
  type PostContent,
  type ProfileContent,
  type SiteIndexContent,
  type WikiPageContent,
} from '../domain/portalContent.ts';
import type { PortalReplica } from '../domain/portalSync.ts';
import type { PortalTrustStore } from './portalTrust.ts';

export interface PortalEntryView {
  id: string;
  kind: string;
  author: string;
  seq: number;
  content: PortalContent;
}

export interface PortalWikiPageView {
  slug: string;
  title: string;
  markdown: string;
  author: string;
  seq: number;
}

export interface PortalViewModel {
  siteIndex: (SiteIndexContent & { author: string; seq: number }) | null;
  profile: (ProfileContent & { author: string; seq: number }) | null;
  posts: (PostContent & { id: string; author: string; seq: number })[];
  wiki: PortalWikiPageView[];
  objects: PortalEntryView[];
  unknown: number;
  authors: { author: string; entries: number; objects: number }[];
}

export interface PortalViewOptions {
  trust?: PortalTrustStore | null;
  scope?: string;
  trustedOnly?: boolean;
}

export function buildPortalView(replica: PortalReplica, options: PortalViewOptions = {}): PortalViewModel {
  const scope = options.scope ?? '';
  const trust = options.trust ?? null;
  const blocked = (author: string) => Boolean(trust && scope && trust.isBlocked(scope, author));
  const trustedOnly = Boolean(options.trustedOnly && trust && scope);

  const entries: PortalEntryView[] = [];
  const counts = new Map<string, { entries: number; objects: number }>();
  let unknown = 0;

  for (const [author, log] of Object.entries(replica.entriesByAuthor)) {
    if (blocked(author)) continue;
    if (trustedOnly && !trust?.isTrusted(scope, author)) continue;
    const authorCount = counts.get(author) ?? { entries: 0, objects: 0 };
    authorCount.entries += log.length;
    for (const entry of log) {
      const object = replica.objectsById[entry.objId];
      if (!object) continue;
      const content = parsePortalContent(object.kind, object.payload);
      if (!content) {
        unknown += 1;
        continue;
      }
      authorCount.objects += 1;
      entries.push({
        id: object.id,
        kind: object.kind,
        author,
        seq: entry.seq,
        content,
      });
    }
    counts.set(author, authorCount);
  }

  const siteIndex = latestOf(entries, PORTAL_KINDS.siteIndex) as
    (SiteIndexContent & { author: string; seq: number }) | null;
  const profile = latestOf(entries, PORTAL_KINDS.profile) as (ProfileContent & { author: string; seq: number }) | null;
  const posts = entries
    .filter((entry) => entry.content.version === 1 && entry.kind === PORTAL_KINDS.post)
    .map((entry) => ({
      ...(entry.content as PostContent),
      id: entry.id,
      author: entry.author,
      seq: entry.seq,
    }))
    .sort((a, b) => b.seq - a.seq || a.author.localeCompare(b.author));

  const wikiBySlug = new Map<string, PortalWikiPageView>();
  for (const entry of entries) {
    if (entry.kind !== PORTAL_KINDS.wikiPage) continue;
    const page = entry.content as WikiPageContent;
    const current = wikiBySlug.get(page.slug);
    if (!current || entry.seq > current.seq || (entry.seq === current.seq && entry.author > current.author)) {
      wikiBySlug.set(page.slug, {
        slug: page.slug,
        title: page.title,
        markdown: page.markdown,
        author: entry.author,
        seq: entry.seq,
      });
    }
  }

  const objects = entries.filter((entry) => entry.kind === PORTAL_KINDS.object);

  return {
    siteIndex,
    profile,
    posts,
    wiki: [...wikiBySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    objects,
    unknown,
    authors: [...counts.entries()]
      .map(([author, count]) => ({ author, ...count }))
      .sort((a, b) => b.objects - a.objects || a.author.localeCompare(b.author)),
  };
}

function latestOf(entries: PortalEntryView[], kind: string): (PortalContent & { author: string; seq: number }) | null {
  let best: PortalEntryView | null = null;
  for (const entry of entries) {
    if (entry.kind !== kind) continue;
    if (!best || entry.seq > best.seq || (entry.seq === best.seq && entry.author > best.author)) best = entry;
  }
  return best
    ? ({ ...best.content, author: best.author, seq: best.seq } as PortalContent & {
        author: string;
        seq: number;
      })
    : null;
}
