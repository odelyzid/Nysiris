/**
 * Display model for local trust standings.
 *
 * Two layers, both first-hand and both staying on this device:
 *
 * 1. Observed standing — from `mixnet/reputation.mjs` (signature checks,
 *    undecryptable DMs, …). No global consensus involved.
 * 2. Explicit verdict — the user taps Trust/Block on an author. An explicit
 *    verdict always wins over the observed score for display.
 *
 * Pure logic, tested with `node --test web/test`.
 */

export type Standing = 'trusted' | 'neutral' | 'watch' | 'blocked' | 'unknown';

export type Verdict = 'trusted' | 'blocked';

export const STANDING_META: Record<Standing, { label: string; color: string; blurb: string }> = {
  trusted: { label: 'Trusted', color: '#0a7a4a', blurb: 'Consistently checks out' },
  neutral: { label: 'New', color: '#888888', blurb: 'Nothing good or bad seen yet' },
  watch: { label: 'Watch', color: '#b26b00', blurb: 'Something looked off — read carefully' },
  blocked: { label: 'Blocked', color: '#b00020', blurb: 'Failed checks or you blocked them' },
  unknown: { label: 'New', color: '#888888', blurb: 'Not seen before' },
};

/** Explicit user verdict wins; otherwise fall back to observed standing. */
export function resolveStanding(explicit: Verdict | null | undefined, observed: Standing): Standing {
  if (explicit === 'trusted' || explicit === 'blocked') return explicit;
  return observed;
}

/**
 * Posts from blocked authors collapse by default (tap to reveal). Everything
 * else renders inline — even `watch`, which gets a caution line instead.
 */
export function shouldCollapse(standing: Standing): boolean {
  return standing === 'blocked';
}

/** Inline caution for `watch` posts; null when no caution applies. */
export function cautionFor(standing: Standing): string | null {
  return standing === 'watch' ? STANDING_META.watch.blurb : null;
}

/** Human line for a dot tooltip, including where the call came from. */
export function standingTitle(standing: Standing, explicit: boolean): string {
  const meta = STANDING_META[standing] ?? STANDING_META.unknown;
  return explicit ? `${meta.label} — your call` : `${meta.label} — ${meta.blurb.toLowerCase()}`;
}

export interface TrustStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'fly.social.trust';

function normalizeAuthor(author: unknown): string | null {
  if (typeof author !== 'string') return null;
  const key = author.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(key) ? key : null;
}

/** Explicit verdicts by author pubkey hex. Unknown/malformed entries dropped. */
export function loadTrust(storage?: TrustStorage | null): Record<string, Verdict> {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, Verdict> = {};
    for (const [author, verdict] of Object.entries(parsed as Record<string, unknown>)) {
      const key = normalizeAuthor(author);
      if (key && (verdict === 'trusted' || verdict === 'blocked')) out[key] = verdict;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveTrust(verdicts: Record<string, Verdict>, storage?: TrustStorage | null): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(verdicts));
  } catch {
    // Private mode: verdicts just don't persist.
  }
}

/** Set (or with `null`, clear) one author's explicit verdict. Never mutates. */
export function withVerdict(
  verdicts: Record<string, Verdict>,
  author: string,
  verdict: Verdict | null,
): Record<string, Verdict> {
  const key = normalizeAuthor(author);
  if (!key) return verdicts;
  const next = { ...verdicts };
  if (verdict === null) delete next[key];
  else next[key] = verdict;
  return next;
}
