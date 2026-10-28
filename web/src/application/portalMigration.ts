/**
 * One-time migration from the old global portal replica.
 *
 * Before workspaces, `PortalSync` persisted everything under
 * `fly.portal.sync.v1`. We only import it into an empty workspace (never merge
 * it silently into another portal), show a notice, and let the user dismiss it.
 */
import type { StorageLike } from '../lib/storage.ts';
import { PORTAL_SYNC_KEY, type PortalReplica } from '../domain/portalSync.ts';
import { loadPortalReplica } from './portalReplicaStore.ts';
import { saveScopedReplica, type PortalReplicaStore } from './portalStore.ts';

export const LEGACY_MIGRATION_DISMISSED_KEY = 'fly.portal.migration.dismissed.v1';

export interface LegacyReplicaSummary {
  authors: number;
  entries: number;
  objects: number;
}

export function legacyReplicaSummary(storage: StorageLike | null): LegacyReplicaSummary | null {
  try {
    const raw = storage?.getItem(PORTAL_SYNC_KEY);
    if (!raw || raw.length < 3) return null;
    const replica = loadPortalReplica(storage);
    const summary = {
      authors: Object.keys(replica.entriesByAuthor).length,
      entries: Object.values(replica.entriesByAuthor).reduce((sum, entries) => sum + entries.length, 0),
      objects: Object.keys(replica.objectsById).length,
    };
    return summary.entries + summary.objects > 0 ? summary : null;
  } catch {
    return null;
  }
}

export function legacyMigrationDismissed(storage: StorageLike | null): boolean {
  try {
    return storage?.getItem(LEGACY_MIGRATION_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissLegacyMigration(storage: StorageLike | null): void {
  try {
    storage?.setItem(LEGACY_MIGRATION_DISMISSED_KEY, '1');
  } catch {
    // Private mode.
  }
}

/** Import the legacy replica only into an empty workspace. */
export async function migrateLegacyReplica(
  storage: StorageLike | null,
  store: PortalReplicaStore,
  scope: string,
  existing: PortalReplica,
): Promise<{ imported: boolean; replica: PortalReplica; reason?: string }> {
  const legacy = loadPortalReplica(storage);
  const legacyEntries = Object.values(legacy.entriesByAuthor).reduce((sum, entries) => sum + entries.length, 0);
  if (legacyEntries === 0 && Object.keys(legacy.objectsById).length === 0) {
    return { imported: false, replica: existing, reason: 'No legacy replica was found.' };
  }
  const existingEntries = Object.values(existing.entriesByAuthor).reduce((sum, entries) => sum + entries.length, 0);
  if (existingEntries > 0 || Object.keys(existing.objectsById).length > 0) {
    return {
      imported: false,
      replica: existing,
      reason: 'This workspace already has a replica; the old global data was left untouched.',
    };
  }
  await saveScopedReplica(store, scope, legacy, storage);
  clearLegacyReplica(storage);
  dismissLegacyMigration(storage);
  return { imported: true, replica: legacy };
}

/** Remove the global key without assuming `removeItem` exists. */
export function clearLegacyReplica(storage: StorageLike | null): void {
  try {
    const removable = storage as (StorageLike & { removeItem?: (key: string) => void }) | null;
    if (removable?.removeItem) removable.removeItem(PORTAL_SYNC_KEY);
    else storage?.setItem(PORTAL_SYNC_KEY, '');
  } catch {
    // Nothing to clear.
  }
}
