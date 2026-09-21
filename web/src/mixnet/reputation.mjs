/**
 * Local reputation from first-hand observation. Mirror of
 * `crates/portal-reputation/src/reputation.rs` (same weights, thresholds,
 * decay) — scores computed here never leave the machine.
 *
 * No dependencies; covered by `node --test web/test`.
 */

export const WEIGHTS = Object.freeze({
  valid: 1,
  duplicate: -1,
  undecryptable: -2,
  invalidSignature: -5,
  equivocation: -10,
});

export const DECAY_HALF_LIFE_DAYS = 30;
const MIN_SCORE = -50;
const MAX_SCORE = 100;

/** @param {number} score @returns {'trusted'|'neutral'|'watch'|'blocked'} */
export function standingOf(score) {
  if (score >= 20) return 'trusted';
  if (score >= 0) return 'neutral';
  if (score > -10) return 'watch';
  return 'blocked';
}

export function createReputation() {
  /** @type {Map<string, { score: number, day: number }>} */
  const scores = new Map();

  function decayed(score, lastDay, today) {
    const halvings = Math.floor(Math.max(0, today - lastDay) / DECAY_HALF_LIFE_DAYS);
    let s = score;
    for (let i = 0; i < Math.min(halvings, 10); i += 1) s = Math.trunc(s / 2);
    return s;
  }

  return {
    observe(authorHex, kind, today) {
      if (!(kind in WEIGHTS)) return;
      const prev = scores.get(authorHex) ?? { score: 0, day: today };
      const next = Math.max(MIN_SCORE, Math.min(MAX_SCORE, prev.score + WEIGHTS[kind]));
      scores.set(authorHex, { score: next, day: today });
    },
    score(authorHex, today) {
      const entry = scores.get(authorHex);
      if (!entry) return 0;
      return decayed(entry.score, entry.day, today);
    },
    standing(authorHex, today) {
      if (!scores.has(authorHex)) return 'unknown';
      return standingOf(this.score(authorHex, today));
    },
    size() {
      return scores.size;
    },
    toJSON() {
      return [...scores.entries()].map(([author, { score, day }]) => ({ author, score, day }));
    },
    load(entries, today) {
      // Silently repair: entries older than the window decay on read anyway.
      if (!Array.isArray(entries)) return;
      for (const e of entries) {
        if (e && typeof e.author === 'string' && Number.isInteger(e.score) && Number.isInteger(e.day)) {
          scores.set(e.author, {
            score: Math.max(MIN_SCORE, Math.min(MAX_SCORE, e.score)),
            day: e.day,
          });
        }
      }
      void today;
    },
  };
}
