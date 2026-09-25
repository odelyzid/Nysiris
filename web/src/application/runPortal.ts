/**
 * Pure logic for the "Run a Portal" tab.
 *
 * The browser is only the *client* (`docs/03-browser-client.md`): a portal
 * service runs as a separate program on a computer, server, or container
 * (`services/portal-provider`, `scripts/run-provider.sh`). This module
 * prepares the decision state, copyable quick-start commands, and the local
 * probe state machine — nothing here talks to the mixnet or runs a service.
 *
 * Dependency-free (no `@noble/*` at import time) so `node --test web/test`
 * covers it offline; key generation lives in `application/identityStore.ts`.
 */
import { toPrivateLink } from '../shared/share.ts';
import { defaultStorage } from '../lib/storage.ts';

export type PortalOs = 'linux' | 'docker' | 'windows';

export type PortalProbe = 'idle' | 'checking' | 'reachable' | 'unreachable';

/** Environment overrides the portal provider honors (see `run-provider.sh`). */
export interface PortalConfig {
  /** Leading-zero bits for object/log PoW (`PORTAL_POW_BITS`). */
  powBits: number;
  /** Max object/log entries per day (`PORTAL_RATE_PER_DAY`). */
  ratePerDay: number;
  /** Persistent identity directory (`SP_DATA_DIR`). Losing it changes the address. */
  dataDir: string;
}

export const DEFAULT_PORTAL_CONFIG: PortalConfig = {
  powBits: 0,
  ratePerDay: 500,
  dataDir: './sp-storage',
};

export interface PortalRunPrefs {
  os: PortalOs | null;
  config: PortalConfig;
  /** Address of the running provider (from its startup output / nym-address.txt). */
  providerAddress: string;
}

export const PORTAL_RUN_KEY = 'fly.portal.run';

export interface ViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const OS_ORDER: PortalOs[] = ['linux', 'docker', 'windows'];

export const PORTAL_OS_ORDER: readonly PortalOs[] = OS_ORDER;

export const PORTAL_OS_META: Record<PortalOs, { title: string; blurb: string }> = {
  linux: { title: 'Linux', blurb: 'Desktop or server binary' },
  docker: { title: 'Docker', blurb: 'Container (no published image yet)' },
  windows: { title: 'Windows', blurb: 'Native provider binary' },
};

/** Best-effort OS guess from a user agent string. Null when unknown. */
export function detectPortalOs(userAgent: string): PortalOs | null {
  const ua = String(userAgent ?? '').toLowerCase();
  if (/windows|win64|win32|microsoft edge|msie|trident/.test(ua)) return 'windows';
  if (/linux|android|ubuntu|debian|fedora|arch/i.test(ua)) return 'linux';
  return null;
}

/** The copyable quick-start snippet for one platform. Never invents an image. */
export function quickStartCommand(os: PortalOs): string {
  switch (os) {
    case 'windows':
      return [
        '# from a terminal inside services\\portal-provider\\',
        '.\\target\\release\\portal-provider.exe',
        '# set before starting (persistent identity + storage):',
        '$env:SP_DATA_DIR = ".\\sp-storage"',
        '$env:PORTAL_DB = ".\\portal.sqlite"',
      ].join('\n');
    case 'docker':
      return [
        '# no published portal image yet — build one from your own repo copy',
        '# the provider only dials out to the mixnet (no inbound ports):',
        'docker run --rm -v ./sp-storage:/data -e SP_DATA_DIR=/data <your-portal-image>',
      ].join('\n');
    case 'linux':
    default:
      return [
        '# first build is heavy (pulls nym-sdk)',
        './build.sh services portal-provider',
        'scripts/run-provider.sh portal',
        '# address prints on startup and lands in services/portal-provider/nym-address.txt',
      ].join('\n');
  }
}

/**
 * Render only environment/flags; never runs anything. Windows gets
 * PowerShell `$env:` assignment syntax so the copied block actually
 * applies on the selected platform, POSIX gets `export`.
 */
export function renderConfigSnippet(config: PortalConfig, os: PortalOs | null = null): string {
  const keys: [string, string][] = [
    ['SP_DATA_DIR', config.dataDir],
    ['PORTAL_POW_BITS', String(config.powBits)],
    ['PORTAL_RATE_PER_DAY', String(config.ratePerDay)],
    ['PORTAL_DB', './portal.sqlite'],
  ];
  return keys.map(([k, v]) => (os === 'windows' ? `$env:${k} = "${v}"` : `export ${k}=${v}`)).join('\n');
}

/** The `nym://`-schemed invite link for a provider address. Empty passthrough. */
export const inviteLinkFor = toPrivateLink;

/** Probe state machine: `idle → checking → reachable|unreachable`. */
export function advanceProbe(prev: PortalProbe, ok: boolean): PortalProbe {
  if (ok) return 'reachable';
  if (prev === 'checking') return 'unreachable';
  return prev;
}

/**
 * Short probe line with measured round-trip latency.
 * Never reports below 1 ms, never jitters on NaN. Pure so it is unit-testable.
 */
export function formatProbeLatency(ms: number): string {
  const rounded = Math.max(1, Math.round(Number(ms) || 0));
  return `latency ~${rounded} ms`;
}

/**
 * GitHub "latest" release page — where CI uploads the built release assets
 * (launcher zip, .deb, Android). Exact asset filenames embed the version, so
 * this page link stays current without guessing per-version names.
 */
export const PORTAL_RELEASE_URL = 'https://github.com/odelyzid/Nysiris/releases/latest';

export function loadPortalRun(storage?: ViewStorage | null): PortalRunPrefs {
  const fallback: PortalRunPrefs = { os: null, config: { ...DEFAULT_PORTAL_CONFIG }, providerAddress: '' };
  try {
    const raw = storage?.getItem(PORTAL_RUN_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PortalRunPrefs> | null;
    if (!parsed || typeof parsed !== 'object') return fallback;
    const os = parsed.os === 'linux' || parsed.os === 'docker' || parsed.os === 'windows' ? parsed.os : null;
    const config = {
      powBits: numberOr(parsed.config?.powBits, DEFAULT_PORTAL_CONFIG.powBits),
      ratePerDay: numberOr(parsed.config?.ratePerDay, DEFAULT_PORTAL_CONFIG.ratePerDay),
      dataDir:
        typeof parsed.config?.dataDir === 'string' && parsed.config.dataDir
          ? parsed.config.dataDir
          : DEFAULT_PORTAL_CONFIG.dataDir,
    };
    return {
      os,
      config,
      providerAddress: typeof parsed.providerAddress === 'string' ? parsed.providerAddress : '',
    };
  } catch {
    return fallback;
  }
}

export function savePortalRun(prefs: PortalRunPrefs, storage?: ViewStorage | null): void {
  try {
    storage?.setItem(PORTAL_RUN_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode: preferences just reset next load.
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** `localStorage` when it exists, otherwise null (SSR/tests/workers). */
export function defaultPortalRunStorage(): ViewStorage | null {
  return defaultStorage();
}
