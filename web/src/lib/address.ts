/**
 * Address and author-key helpers shared by the social + portal layers.
 * Dependency-free, node-testable (repo convention).
 */

/**
 * Normalize an author reference to lowercase 64-hex, or null when it isn't
 * one. Used as the canonical key for trust verdicts, petnames, and portal
 * replica lookups — a single copy so every map keys the same way.
 */
export function normalizeAuthor(author: unknown): string | null {
  if (typeof author !== 'string') return null;
  const key = author.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(key) ? key : null;
}

/** True when `value` is a lowercase 64-hex author key. */
export function isAuthorKey(value: unknown): boolean {
  return normalizeAuthor(value) !== null;
}
