/**
 * Structured portal sync conflicts and the explicit manual reset.
 *
 * Forks are never merged automatically. The UI explains why an author was
 * rejected and offers a deliberate `resetAuthorLog`, which drops only that
 * author's local log/objects so the next sync can re-fetch from a chosen
 * provider.
 */
import type { PortalReplica } from '../domain/portalSync.ts';

export type PortalSyncIssueKind = 'fork' | 'signature' | 'gap' | 'missing-object' | 'malformed';

export interface PortalSyncIssue {
  author: string;
  kind: PortalSyncIssueKind;
  detail: string;
  expectedSeq: number | null;
  gotSeq: number | null;
}

/** Classify the error strings produced by `mergePortalEntries`/verifiers. */
export function classifyPortalSyncError(author: string, error: unknown): PortalSyncIssue {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();
  let kind: PortalSyncIssueKind = 'malformed';
  if (lower.includes('fork') || lower.includes('expected seq') || lower.includes('gap')) kind = 'fork';
  else if (lower.includes('obj ') || lower.includes('object')) kind = 'missing-object';
  else if (lower.includes('signature')) kind = 'signature';

  const expected = /expected seq (\d+)/i.exec(message);
  const got = /got (\d+)/i.exec(message);
  return {
    author: String(author ?? '').toLowerCase(),
    kind,
    detail: message.slice(0, 240) || 'sync rejected this author',
    expectedSeq: expected ? Number(expected[1]) : null,
    gotSeq: got ? Number(got[1]) : null,
  };
}

/** Deduplicate issues by author, keeping the newest/most specific explanation. */
export function mergePortalIssues(...groups: PortalSyncIssue[][]): PortalSyncIssue[] {
  const byAuthor = new Map<string, PortalSyncIssue>();
  for (const group of groups) {
    for (const issue of group) {
      if (!issue.author) continue;
      byAuthor.set(issue.author, issue);
    }
  }
  return [...byAuthor.values()];
}

/**
 * Manual reset: remove one author's log and any objects that are no longer
 * referenced by another author. Returns the next replica plus the removed
 * object ids (for an undo/inspection UI).
 */
export function resetAuthorLog(
  replica: PortalReplica,
  author: string,
): { replica: PortalReplica; removedObjects: string[] } {
  const clean = String(author ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    return { replica, removedObjects: [] };
  }
  const entriesByAuthor = { ...replica.entriesByAuthor };
  const removed = entriesByAuthor[clean] ?? [];
  delete entriesByAuthor[clean];

  const stillNeeded = new Set<string>();
  for (const entries of Object.values(entriesByAuthor)) {
    for (const entry of entries) stillNeeded.add(entry.objId);
  }
  const objectsById = { ...replica.objectsById };
  const removedObjects: string[] = [];
  for (const entry of removed) {
    if (stillNeeded.has(entry.objId)) continue;
    if (entry.objId in objectsById) {
      delete objectsById[entry.objId];
      removedObjects.push(entry.objId);
    }
  }
  return { replica: { entriesByAuthor, objectsById }, removedObjects };
}
