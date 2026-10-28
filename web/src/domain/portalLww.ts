/**
 * Browser port of `portal-data::lww`.
 *
 * Each key holds the value with the greatest dot `(day, author, objHash)`.
 * Merge is union + max, so replicas converge regardless of exchange order.
 * The browser uses this for wiki/profile map state; the provider only stores
 * the signed objects that carry the values.
 */

export interface PortalDot {
  day: number;
  /** Author public key (hex). */
  author: string;
  /** Object/content hash (hex). */
  objHash: string;
}

export interface PortalLwwEntry {
  key: string;
  dot: PortalDot;
  value: string;
}

export function compareDots(a: PortalDot, b: PortalDot): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.author !== b.author) return a.author < b.author ? -1 : 1;
  if (a.objHash !== b.objHash) return a.objHash < b.objHash ? -1 : 1;
  return 0;
}

export class PortalLwwMap {
  private readonly entries = new Map<string, { dot: PortalDot; value: string }>();

  constructor(entries: PortalLwwEntry[] = []) {
    for (const entry of entries) this.insert(entry.key, entry.dot, entry.value);
  }

  /** Insert only if the dot beats the current value. Returns true on change. */
  insert(key: string, dot: PortalDot, value: string): boolean {
    if (!validKey(key) || !validDot(dot)) return false;
    const current = this.entries.get(key);
    if (current && compareDots(current.dot, dot) >= 0) return false;
    this.entries.set(key, { dot: { ...dot }, value });
    return true;
  }

  get(key: string): string | null {
    return this.entries.get(key)?.value ?? null;
  }

  getDot(key: string): PortalDot | null {
    const entry = this.entries.get(key);
    return entry ? { ...entry.dot } : null;
  }

  merge(other: PortalLwwMap | PortalLwwEntry[]): void {
    const entries = other instanceof PortalLwwMap ? other.toEntries() : other;
    for (const entry of entries) this.insert(entry.key, entry.dot, entry.value);
  }

  toEntries(): PortalLwwEntry[] {
    return [...this.entries.entries()]
      .map(([key, { dot, value }]) => ({ key, dot: { ...dot }, value }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  get size(): number {
    return this.entries.size;
  }
}

function validKey(key: string): boolean {
  return typeof key === 'string' && key.length > 0 && key.length <= 256;
}

function validDot(dot: PortalDot): boolean {
  return (
    Number.isSafeInteger(dot.day) &&
    dot.day >= 0 &&
    /^[0-9a-f]{64}$/i.test(dot.author) &&
    /^[0-9a-f]{64}$/i.test(dot.objHash)
  );
}
