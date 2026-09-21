/**
 * Local petnames for community authors: names only you see.
 *
 * A petname maps an author's public-key hex to a short label. It lives in
 * localStorage, never leaves the device, and wins over self-asserted profile
 * names for display (your name for them beats their name for themselves).
 *
 * Pure logic, tested with `node --test web/test`.
 */

export interface PetnameStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'fly.social.petnames';
export const MAX_PETNAME_LENGTH = 40;

export function normalizeAuthor(author: unknown): string | null {
  if (typeof author !== 'string') return null;
  const key = author.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(key) ? key : null;
}

export function cleanPetname(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > MAX_PETNAME_LENGTH) return null;
  return trimmed;
}

/** Petnames by author pubkey hex. Unknown/malformed entries dropped. */
export function loadPetnames(storage?: PetnameStorage | null): Record<string, string> {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [author, name] of Object.entries(parsed as Record<string, unknown>)) {
      const key = normalizeAuthor(author);
      const clean = cleanPetname(name);
      if (key && clean) out[key] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

export function savePetnames(petnames: Record<string, string>, storage?: PetnameStorage | null): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(petnames));
  } catch {
    // Private mode: petnames just don't persist.
  }
}

/**
 * Display name priority: your petname > their self-asserted profile name >
 * short hex. `profileName` may be null/empty when no profile was found.
 */
export function authorLabel(author: string, petname?: string | null, profileName?: string | null): string {
  const pet = typeof petname === 'string' ? petname.trim() : '';
  if (pet) return pet;
  const profile = typeof profileName === 'string' ? profileName.trim() : '';
  if (profile) return profile;
  const key = author.trim();
  return key.length > 12 ? `${key.slice(0, 12)}…` : key;
}

/** Set (or with empty/null, clear) one author's petname. Never mutates. */
export function withPetname(
  petnames: Record<string, string>,
  author: string,
  name: string | null,
): Record<string, string> {
  const key = normalizeAuthor(author);
  if (!key) return petnames;
  const next = { ...petnames };
  const clean = name === null ? null : cleanPetname(name);
  if (clean === null) delete next[key];
  else next[key] = clean;
  return next;
}

/**
 * Petnames claimed by more than one author, compared case-insensitively:
 * `{ displayName: [authorHex, ...] }` (authors sorted). Callers append a hex
 * suffix to these names so two people called "bob" don't merge into one.
 */
export function duplicatePetnames(petnames: Record<string, string>): Record<string, string[]> {
  const groups = new Map<string, { label: string; authors: string[] }>();
  for (const [author, name] of Object.entries(petnames)) {
    const fold = name.trim().toLowerCase();
    if (!fold) continue;
    const group = groups.get(fold) ?? { label: name.trim(), authors: [] };
    group.authors.push(author);
    groups.set(fold, group);
  }
  const out: Record<string, string[]> = {};
  for (const { label, authors } of groups.values()) {
    if (authors.length > 1) out[label] = [...authors].sort();
  }
  return out;
}
