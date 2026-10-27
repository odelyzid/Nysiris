/**
 * Per-site capability decisions.
 *
 * Pages cannot run scripts yet, so this is the control surface the shell will
 * consult when a future page feature asks for a capability. Decisions are
 * explicit (`ask` / `allow` / `deny`), scoped to the document's origin (or Nym
 * service), and persisted locally. They are not OS/browser permission grants:
 * the OS prompt still applies where a real API is used.
 */
import type { StorageLike } from '../lib/storage.ts';
import { authScopeFor } from './auth.ts';

export type PermissionName = 'camera' | 'microphone' | 'geolocation' | 'notifications' | 'clipboard';
export type PermissionDecision = 'ask' | 'allow' | 'deny';

export const PERMISSIONS_KEY = 'fly.browser.permissions.v1';
export const MAX_SCOPES = 64;

export const PERMISSION_NAMES: PermissionName[] = ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard'];

export const PERMISSION_META: Record<PermissionName, { label: string; description: string }> = {
  camera: { label: 'Camera', description: 'Scan QR codes and attach photos.' },
  microphone: { label: 'Microphone', description: 'Record voice messages.' },
  geolocation: { label: 'Location', description: 'Share your approximate location with a site.' },
  notifications: { label: 'Notifications', description: 'Show updates while the app is in the background.' },
  clipboard: { label: 'Clipboard', description: 'Read text you copy from a site.' },
};

export type PermissionMap = Partial<Record<PermissionName, PermissionDecision>>;

interface StoredPermissions {
  version: 1;
  scopes: Record<string, PermissionMap>;
}

export class PermissionRegistry {
  private scopes = new Map<string, PermissionMap>();

  constructor(initial: Record<string, PermissionMap> = {}) {
    for (const [scope, map] of Object.entries(initial).slice(0, MAX_SCOPES)) {
      if (!scope || !map || typeof map !== 'object') continue;
      const clean: PermissionMap = {};
      for (const name of PERMISSION_NAMES) {
        const value = map[name];
        if (isDecision(value)) clean[name] = value;
      }
      this.scopes.set(scope, clean);
    }
  }

  get(scope: string, name: PermissionName): PermissionDecision {
    return this.scopes.get(normaliseScope(scope))?.[name] ?? 'ask';
  }

  set(scope: string, name: PermissionName, decision: PermissionDecision): void {
    const key = normaliseScope(scope);
    if (!key || !isDecision(decision) || !PERMISSION_NAMES.includes(name)) return;
    const map = { ...(this.scopes.get(key) ?? {}) };
    if (decision === 'ask') delete map[name];
    else map[name] = decision;
    if (Object.keys(map).length === 0) this.scopes.delete(key);
    else {
      // Refresh insertion order so the oldest scope is evicted first.
      this.scopes.delete(key);
      this.scopes.set(key, map);
    }
    while (this.scopes.size > MAX_SCOPES) {
      const oldest = this.scopes.keys().next().value;
      if (oldest === undefined) break;
      this.scopes.delete(oldest);
    }
  }

  allows(scope: string, name: PermissionName): boolean {
    return this.get(scope, name) === 'allow';
  }

  denied(scope: string, name: PermissionName): boolean {
    return this.get(scope, name) === 'deny';
  }

  clear(scope?: string): void {
    if (scope === undefined) {
      this.scopes.clear();
      return;
    }
    this.scopes.delete(normaliseScope(scope));
  }

  toJSON(): Record<string, PermissionMap> {
    return Object.fromEntries([...this.scopes].map(([scope, map]) => [scope, { ...map }]));
  }

  get size(): number {
    return this.scopes.size;
  }
}

export function permissionScopeFor(url: string): string {
  return authScopeFor(url) || 'app';
}

export function loadPermissions(storage: StorageLike | null): PermissionRegistry {
  try {
    const raw = storage?.getItem(PERMISSIONS_KEY);
    if (!raw) return new PermissionRegistry();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return new PermissionRegistry();
    const state = parsed as Partial<StoredPermissions>;
    if (state.version !== 1 || !state.scopes || typeof state.scopes !== 'object') {
      return new PermissionRegistry();
    }
    return new PermissionRegistry(state.scopes as Record<string, PermissionMap>);
  } catch {
    return new PermissionRegistry();
  }
}

export function savePermissions(storage: StorageLike | null, registry: PermissionRegistry): void {
  try {
    const state: StoredPermissions = { version: 1, scopes: registry.toJSON() };
    storage?.setItem(PERMISSIONS_KEY, JSON.stringify(state));
  } catch {
    // Private mode/quota: decisions just reset next load.
  }
}

function normaliseScope(scope: string): string {
  return String(scope ?? '')
    .trim()
    .slice(0, 512);
}

function isDecision(value: unknown): value is PermissionDecision {
  return value === 'ask' || value === 'allow' || value === 'deny';
}
