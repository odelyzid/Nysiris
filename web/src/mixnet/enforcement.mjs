/**
 * Browser-runtime enforcement controls.
 *
 * Mirrors `crates/sphinx-core/src/enforcement.rs` and the relevant sections of
 * `docs/05-security.md`, so the browser client enforces the same policy as the
 * reference core:
 *
 * | Control | Security section | Export |
 * |---|---|---|
 * | SURB/reply single-use + TTL | §5.3.1, §5.3.3 | `ReplyTracker`, `messageKey` |
 * | Bounded reply rate | §5.3.4 | `ReplyBudget` |
 * | Cover-traffic guardrail | §5.8 | `requireCoverTraffic`, `DEFAULT_PRIVACY_PROFILE` |
 * | Exit rotation guidance | §5.2.2, §5.4.3 | `ExitPolicy`, `ExitRotation` |
 *
 * Kept free of browser globals so `node --test web/test` can verify it.
 */

/** ~25 hours: the SURB validity window (§5.3.3). */
export const DEFAULT_SURB_MAX_AGE_MS = 25 * 60 * 60 * 1000;

/** Default cap on how many SURBs/replies a session will track. */
export const DEFAULT_MAX_TRACKED_REPLIES = 4096;

/**
 * FNV-1a hash, hex. Used to build a compact, stable message key without
 * pulling in a hashing dependency.
 *
 * @param {string} input
 * @returns {string}
 */
export function stableHash(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Build the dedupe key for an inbound reply: the sender tag (the SURB handle)
 * plus a hash of the payload.
 *
 * @param {string | undefined} senderTag
 * @param {string} text
 * @returns {string}
 */
export function messageKey(senderTag, text) {
  return `${senderTag ?? 'no-tag'}:${stableHash(text)}`;
}

/**
 * Tracks inbound replies and enforces single-use + expiry (§5.3.1, §5.3.3).
 *
 * The Nym SDK enforces SURB single-use inside the mixnet itself; this adds the
 * application-level discipline the client owns: never process the same reply
 * twice, and forget tracking entries once the SURB window has passed.
 */
export class ReplyTracker {
  /**
   * @param {{ ttlMs?: number, maxEntries?: number, now?: () => number }} [options]
   */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SURB_MAX_AGE_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_TRACKED_REPLIES;
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, number>} */
    this.entries = new Map();
  }

  /**
   * Accept a reply key once. Returns `false` for a duplicate (single-use
   * violation) and records new keys.
   *
   * @param {string} key
   * @returns {boolean} true when the caller should process the reply
   */
  accept(key) {
    this.purge();
    if (this.entries.has(key)) return false;
    this.entries.set(key, this.now());
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return true;
  }

  /** Drop entries older than the SURB window. Returns the number removed. */
  purge() {
    const cutoff = this.now() - this.ttlMs;
    let removed = 0;
    for (const [key, seenAt] of this.entries) {
      if (seenAt < cutoff) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size() {
    return this.entries.size;
  }
}

/**
 * Token-bucket reply budget, mirroring the Rust `ReplyBudget` (§5.3.4).
 * Caps outbound replies so one conversation cannot exhaust the shared
 * ~50 packet/s budget.
 */
export class ReplyBudget {
  /**
   * @param {number} capacity burst size
   * @param {number} refillPerSec sustained replies per second
   * @param {() => number} [now]
   */
  constructor(capacity, refillPerSec, now = () => Date.now()) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  refill() {
    const now = this.now();
    const elapsedSec = Math.max(0, now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefillMs = now;
  }

  /** Try to spend one reply. Returns false when the budget is exhausted. */
  tryTake() {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  available() {
    this.refill();
    return Math.floor(this.tokens);
  }
}

/** Default privacy profile: both protections on. */
export const DEFAULT_PRIVACY_PROFILE = Object.freeze({
  coverTraffic: true,
  poissonPacing: true,
});

/**
 * Guardrail for §5.8: turning off cover traffic or Poisson pacing weakens the
 * client against a network observer (L3G). Fail closed unless the caller
 * explicitly acknowledges the downgrade.
 *
 * @param {{ coverTraffic?: boolean, poissonPacing?: boolean } | undefined} profile
 * @param {boolean} acknowledged
 */
export function requireCoverTraffic(profile, acknowledged) {
  const cover = profile?.coverTraffic ?? true;
  const poisson = profile?.poissonPacing ?? true;
  if ((cover && poisson) || acknowledged === true) return;
  throw new Error(
    'privacy downgrade refused: cover traffic / Poisson pacing disabled without ' +
      'acknowledgement. This weakens you against a network observer (L3G). ' +
      'Pass privacyDowngradeAcknowledged: true to proceed deliberately.',
  );
}

/** Exit selection policy (§5.2.2, §5.4.3). */
export const ExitRotation = Object.freeze({
  /** A new exit for every request. Best for P2, but impossible per-request here. */
  PerRequest: 'per_request',
  /** Reuse an exit for a bounded number of requests. */
  Every: 'every',
  /** Pin one exit and accept the linkability trade-off. */
  Pinned: 'pinned',
});

/**
 * Tracks requests against an exit-rotation policy.
 *
 * Honest constraint: the shared `mix-tunnel` is **one-shot per page** and picks
 * one exit (IPR) at setup, so true per-request rotation requires a page reload.
 * This class therefore does not silently pretend to rotate; it counts requests
 * and tells the UI when a reconnect is recommended.
 *
 * The reconnect threshold carries ±`jitter` randomisation (§5.2.3): a fixed,
 * publicly-known request count would let a destination predict exactly when a
 * client rotates exits, which is itself a timing signal. The threshold is drawn
 * once per instance (and on `reset()`), from an injectable `random` source so
 * tests stay deterministic.
 */
export class ExitPolicy {
  /**
   * @param {{ policy?: string, maxRequests?: number, jitter?: number, random?: () => number }} [options]
   */
  constructor(options = {}) {
    this.policy = options.policy ?? ExitRotation.Every;
    this.maxRequests = options.maxRequests ?? 50;
    this.jitter = options.jitter ?? 0;
    this.random = options.random ?? Math.random;
    this.count = 0;
    this.threshold = this.drawThreshold();
  }

  drawThreshold() {
    if (this.policy === ExitRotation.PerRequest) return 1;
    if (!(this.jitter > 0)) return this.maxRequests;
    const span = 2 * this.jitter + 1;
    const offset = Math.floor(this.random() * span) - this.jitter;
    return Math.max(1, this.maxRequests + offset);
  }

  recordRequest() {
    this.count += 1;
  }

  /** True when the UI should recommend reconnecting to obtain a fresh exit. */
  shouldRecommendReconnect() {
    if (this.policy === ExitRotation.Pinned) return false;
    return this.count >= this.threshold;
  }

  /** Start a fresh exit window (call after a reconnect). */
  reset() {
    this.count = 0;
    this.threshold = this.drawThreshold();
  }

  /** Why reconnection is needed, for the UI. */
  static get reconnectNote() {
    return (
      'The Nym tunnel is one-shot per page and selects its exit at setup, so a ' +
      'fresh exit requires a reconnect (page reload).'
    );
  }
}
