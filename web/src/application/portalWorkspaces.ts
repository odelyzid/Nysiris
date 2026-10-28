/**
 * Portal workspaces: one record per canonical portal scope.
 *
 * Workspaces are separate from browser tabs. Tabs still bind Social by service;
 * a workspace adds portal-specific identity/trust/replica metadata and the
 * active section. Persistence is small metadata only (localStorage); replica
 * bytes live in IndexedDB (see `portalStore.ts`).
 */
import type { StorageLike } from '../lib/storage.ts';

export const PORTAL_WORKSPACES_KEY = 'fly.portal.workspaces.v1';
export const PORTAL_ACTIVE_WORKSPACE_KEY = 'fly.portal.workspaces.active';
export const MAX_PORTAL_WORKSPACES = 24;

export type PortalFollowState = 'following' | 'paused';

export interface PortalWorkspace {
  /** Canonical scope, also the id. */
  id: string;
  scope: string;
  title: string;
  identityPub: string | null;
  lastSyncedAt: number | null;
  followState: PortalFollowState;
  activeSection: 'feed' | 'wiki' | 'objects' | 'profile';
}

export interface PortalWorkspaceState {
  version: 1;
  activeId: string;
  workspaces: PortalWorkspace[];
}

export function emptyWorkspace(scope: string, title = ''): PortalWorkspace {
  const clean = normalisePortalScope(scope);
  return {
    id: clean,
    scope: clean,
    title: title.trim().slice(0, 120) || clean,
    identityPub: null,
    lastSyncedAt: null,
    followState: 'following',
    activeSection: 'feed',
  };
}

/** Canonical scope: `nym://address`, or an http(s) origin/url as supplied. */
export function normalisePortalScope(input: string): string {
  const value = String(input ?? '').trim();
  if (!value) return '';
  if (/^nym:\/\//i.test(value)) return value;
  if (/^(https?:\/\/)/i.test(value)) return value;
  // Bare Nym address (`id.enc@gw`) from the existing tab/service model.
  if (/^[^\s/@]+\.[^\s/@]+@[^\s/]+(?:\/.*)?$/.test(value)) return `nym://${value}`;
  return value;
}

/** Transport recipient for `fetchNym` (bare address, no scheme/path). */
export function portalTransportAddress(scope: string): string {
  const canonical = normalisePortalScope(scope);
  if (/^nym:\/\//i.test(canonical)) return canonical.slice('nym://'.length).split(/[/?#]/)[0];
  return canonical;
}

export function upsertWorkspace(workspaces: PortalWorkspace[], workspace: PortalWorkspace): PortalWorkspace[] {
  if (!workspace.scope) return [...workspaces];
  const rest = workspaces.filter((item) => item.scope !== workspace.scope);
  return [workspace, ...rest].slice(0, MAX_PORTAL_WORKSPACES);
}

export function removeWorkspace(workspaces: PortalWorkspace[], id: string): PortalWorkspace[] {
  return workspaces.filter((workspace) => workspace.id !== id);
}

export function findWorkspace(
  workspaces: PortalWorkspace[],
  idOrScope: string | null | undefined,
): PortalWorkspace | null {
  const key = normalisePortalScope(String(idOrScope ?? '').trim());
  if (!key) return null;
  return workspaces.find((workspace) => workspace.id === key || workspace.scope === key) ?? null;
}

export function loadPortalWorkspaces(storage: StorageLike | null): PortalWorkspaceState {
  try {
    const raw = storage?.getItem(PORTAL_WORKSPACES_KEY);
    if (!raw) return { version: 1, activeId: '', workspaces: [] };
    const parsed = JSON.parse(raw) as Partial<PortalWorkspaceState>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.workspaces)) {
      return { version: 1, activeId: '', workspaces: [] };
    }
    const seen = new Set<string>();
    const workspaces: PortalWorkspace[] = [];
    for (const item of parsed.workspaces.slice(0, MAX_PORTAL_WORKSPACES)) {
      const workspace = parseWorkspace(item);
      if (!workspace || seen.has(workspace.scope)) continue;
      seen.add(workspace.scope);
      workspaces.push(workspace);
    }
    const activeId =
      typeof parsed.activeId === 'string' && workspaces.some((workspace) => workspace.id === parsed.activeId)
        ? parsed.activeId
        : (workspaces[0]?.id ?? '');
    return { version: 1, activeId, workspaces };
  } catch {
    return { version: 1, activeId: '', workspaces: [] };
  }
}

export function savePortalWorkspaces(storage: StorageLike | null, state: PortalWorkspaceState): void {
  try {
    const activeId = state.workspaces.some((workspace) => workspace.id === state.activeId)
      ? state.activeId
      : (state.workspaces[0]?.id ?? '');
    storage?.setItem(
      PORTAL_WORKSPACES_KEY,
      JSON.stringify({
        version: 1,
        activeId,
        workspaces: state.workspaces.slice(0, MAX_PORTAL_WORKSPACES),
      } satisfies PortalWorkspaceState),
    );
  } catch {
    // Quota/private mode: workspaces reset next load.
  }
}

export function loadActiveWorkspaceId(storage: StorageLike | null): string {
  try {
    return storage?.getItem(PORTAL_ACTIVE_WORKSPACE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveActiveWorkspaceId(storage: StorageLike | null, id: string): void {
  try {
    storage?.setItem(PORTAL_ACTIVE_WORKSPACE_KEY, id);
  } catch {
    // Private mode.
  }
}

function parseWorkspace(value: unknown): PortalWorkspace | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<PortalWorkspace>;
  const scope = normalisePortalScope(typeof raw.scope === 'string' ? raw.scope : '');
  if (!scope || !/^(nym:\/\/|https?:\/\/)/i.test(scope)) return null;
  const activeSection =
    raw.activeSection === 'wiki' || raw.activeSection === 'objects' || raw.activeSection === 'profile'
      ? raw.activeSection
      : 'feed';
  return {
    id: scope,
    scope,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 120) : scope,
    identityPub:
      typeof raw.identityPub === 'string' && /^[0-9a-f]{64}$/i.test(raw.identityPub)
        ? raw.identityPub.toLowerCase()
        : null,
    lastSyncedAt:
      typeof raw.lastSyncedAt === 'number' && Number.isFinite(raw.lastSyncedAt) && raw.lastSyncedAt > 0
        ? raw.lastSyncedAt
        : null,
    followState: raw.followState === 'paused' ? 'paused' : 'following',
    activeSection,
  };
}
