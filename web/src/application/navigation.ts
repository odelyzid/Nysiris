/**
 * Browser address resolution.
 *
 * One entry point for the address bar, saved links, contacts, and the mobile
 * open-link cards. It classifies input into exactly two navigable spaces:
 *
 * * `nym:` / bare `<id>.<enc>@<gw>` / invite links -> pure mixnet service
 * * `http:` / `https:` -> clearnet through the exit gateway
 *
 * Pure and browser-global-free so `node --test web/test` covers it.
 */
import { parseInviteLink } from '../mixnet/hiddenService.mjs';

export type NavigationKind = 'nym' | 'clearnet';

export interface ParsedInvite {
  service: string;
  inviter: string;
  note: string;
  sig: string;
  vouches?: string[];
}

export interface NymTarget {
  kind: 'nym';
  /** Canonical `nym://<address><path>`; never carries the invite fragment. */
  url: string;
  /** `<identity>.<encryption>@<gateway>` without path. */
  address: string;
  /** Request path, always starting with `/`. */
  path: string;
  invite: ParsedInvite | null;
}

export interface ClearnetTarget {
  kind: 'clearnet';
  /** Canonical URL including path, query, and fragment. */
  url: string;
  /** Origin (`https://host[:port]`). */
  address: string;
  /** Path + query sent to the exit. */
  path: string;
  invite: null;
}

export type NavigationTarget = NymTarget | ClearnetTarget;

export interface ResolveOptions {
  /** Case-insensitive petname -> Nym address map (contacts, bookmarks, …). */
  petnames?: Record<string, string>;
}

const MAX_INPUT_LENGTH = 4096;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolve typed/pasted input into a navigable target.
 *
 * @throws {Error} with a user-readable reason when the input is empty,
 *   unsupported, or malformed.
 */
export function resolveNavigationInput(input: string, options: ResolveOptions = {}): NavigationTarget {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Enter a nym:// address or an https:// URL');
  if (raw.length > MAX_INPUT_LENGTH) throw new Error('address is too long');

  const expanded = expandPetname(raw, options.petnames);
  if (/^https?:\/\//i.test(expanded)) return resolveClearnet(expanded);

  if (SCHEME.test(expanded) && !/^nym:/i.test(expanded)) {
    throw new Error('only nym:// and http(s):// addresses are supported');
  }

  return resolveNym(expanded);
}

function expandPetname(input: string, petnames?: Record<string, string>): string {
  if (!petnames) return input;
  const key = input.toLowerCase();
  return Object.prototype.hasOwnProperty.call(petnames, key) ? petnames[key] : input;
}

function resolveClearnet(input: string): ClearnetTarget {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('that URL is not valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http:// and https:// URLs are supported');
  }
  if (!url.hostname) throw new Error('that URL has no host');
  return {
    kind: 'clearnet',
    url: url.toString(),
    address: url.origin,
    path: `${url.pathname}${url.search}`,
    invite: null,
  };
}

function resolveNym(input: string): NymTarget {
  // `splitNymUri` matches the scheme case-sensitively; normalise it first.
  const normalized = input.replace(/^nym:\/\//i, 'nym://');
  let parsed: { address: string; path: string; invite: unknown };
  try {
    parsed = parseInviteLink(normalized) as { address: string; path: string; invite: unknown };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`not a nym address: ${detail}`);
  }
  const path = parsed.path.startsWith('/') ? parsed.path : `/${parsed.path}`;
  const invite = (parsed.invite ?? null) as ParsedInvite | null;
  return {
    kind: 'nym',
    url: canonicalNymUrl(parsed.address, path),
    address: parsed.address,
    path,
    invite,
  };
}

/** Stable display/history URL for a Nym service. */
export function canonicalNymUrl(address: string, path = '/'): string {
  const cleanPath = path.trim() || '/';
  return `nym://${address.trim()}${cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`}`;
}

/** Human label for an address bar / history row without hiding the kind. */
export function targetLabel(target: NavigationTarget): string {
  return target.kind === 'nym' ? target.url : target.address;
}

/** True when `input` is an explicit clearnet URL (for UI hints). */
export function isClearnetInput(input: string): boolean {
  return /^https?:\/\//i.test(String(input ?? '').trim());
}
