/**
 * Conversation list over decrypted 1:1 DM records.
 *
 * The dead-drop is destructive on read and carries no sender (by design), so
 * the browser keeps a local cache: every decrypted message becomes a record
 * keyed by sender (`from` from the signed inner envelope, `dm.ts`), deduped
 * by `msgId`, grouped per peer, newest conversation first. Read watermarks
 * drive unread badges.
 *
 * Pure logic (no browser globals): unit-testable with `node --test web/test`.
 */

export interface DmRecord {
  /** Sender/recipient ed pubkey hex (lowercase), or 'unknown' for legacy plaintext DMs. */
  peer: string;
  /** True for received messages, false for messages we sent. */
  incoming: boolean;
  text: string;
  /** Local send/receive time (ms epoch). */
  at: number;
  /** Sender timestamp from the inner envelope (ms epoch); equals `at` for legacy. */
  ts: number;
  /** Inner-envelope id; `local:<rand>` for legacy records without one. */
  msgId: string;
}

export interface Conversation {
  peer: string;
  /** Oldest first. */
  messages: DmRecord[];
  lastAt: number;
  unread: number;
}

/** Cap on cached records: the dead-drop is gone after read, the cache is the history. */
export const MAX_DM_RECORDS = 500;

export interface DmStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const CACHE_KEY = 'fly.social.dmcache';
const READ_KEY = 'fly.social.dmread';

/** Append unless `msgId` is already present; drops oldest past the cap. Never mutates. */
export function addDmRecord(records: DmRecord[], rec: DmRecord): DmRecord[] {
  if (records.some((r) => r.msgId === rec.msgId)) return records;
  const next = [...records, rec];
  return next.length > MAX_DM_RECORDS ? next.slice(next.length - MAX_DM_RECORDS) : next;
}

/** Group records per peer, conversations newest-first, messages oldest-first. */
export function groupConversations(
  records: DmRecord[],
  readAt: Record<string, number>,
): Conversation[] {
  const byPeer = new Map<string, DmRecord[]>();
  for (const rec of records) {
    const list = byPeer.get(rec.peer) ?? [];
    list.push(rec);
    byPeer.set(rec.peer, list);
  }
  const out: Conversation[] = [];
  for (const [peer, messages] of byPeer) {
    messages.sort((a, b) => a.at - b.at);
    const lastAt = messages.length > 0 ? messages[messages.length - 1].at : 0;
    const watermark = readAt[peer] ?? 0;
    const unread = messages.filter((m) => m.incoming && m.at > watermark).length;
    out.push({ peer, messages, lastAt, unread });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);
  return out;
}

/** Move a peer's read watermark forward (never backward). Never mutates. */
export function markConversationRead(
  readAt: Record<string, number>,
  peer: string,
  at: number = Date.now(),
): Record<string, number> {
  const prev = readAt[peer] ?? 0;
  if (at <= prev) return readAt;
  return { ...readAt, [peer]: at };
}

function isRecord(value: unknown): value is DmRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.peer === 'string' &&
    r.peer.length > 0 &&
    typeof r.incoming === 'boolean' &&
    typeof r.text === 'string' &&
    Number.isFinite(r.at) &&
    Number.isFinite(r.ts) &&
    typeof r.msgId === 'string' &&
    r.msgId.length > 0
  );
}

/** Cached records for this device. Malformed entries are dropped. */
export function loadDmCache(storage?: DmStore | null): DmRecord[] {
  try {
    const raw = storage?.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).filter(isRecord).slice(-MAX_DM_RECORDS);
  } catch {
    return [];
  }
}

export function saveDmCache(records: DmRecord[], storage?: DmStore | null): void {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify(records.slice(-MAX_DM_RECORDS)));
  } catch {
    // Private mode: history just doesn't persist.
  }
}

function isWatermarks(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => Number.isFinite(v));
}

/** Read watermarks per peer. Malformed entries are dropped. */
export function loadDmRead(storage?: DmStore | null): Record<string, number> {
  try {
    const raw = storage?.getItem(READ_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isWatermarks(parsed)) return {};
    return { ...(parsed as Record<string, number>) };
  } catch {
    return {};
  }
}

export function saveDmRead(readAt: Record<string, number>, storage?: DmStore | null): void {
  try {
    storage?.setItem(READ_KEY, JSON.stringify(readAt));
  } catch {
    // Private mode: badges just reset.
  }
}
