/**
 * Stable, per-device client id for the Nym messaging client.
 *
 * The mixnet/WASM client keys its persisted identity — and therefore your Nym
 * address — by the `clientId` handed to `client.start()`. A fresh id per page
 * load rotates your address every session, so replies to the address you shared
 * never arrive. Persist one id per device instead; the SDK keeps the key
 * material in IndexedDB under this id (clear both to rotate the identity).
 *
 * Pure + injected storage (same pattern as `application/views.ts`), so it is
 * unit-testable with `node --test web/test` without a browser.
 */

export interface IdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const CLIENT_ID_KEY = 'fly.messages.clientId';

/** A fresh id; falls back when `crypto.randomUUID` is unavailable. */
export function newClientId(): string {
  const unique =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `nysiris-${unique}`;
}

/**
 * Read the persisted client id, creating and storing one on first use. The id
 * must stay stable across sessions or your Nym address changes every load.
 */
export function messageClientId(storage?: IdStorage | null): string {
  let existing: string | null = null;
  try {
    existing = storage?.getItem(CLIENT_ID_KEY)?.trim() ?? null;
  } catch {
    existing = null;
  }
  if (existing) return existing;

  const id = newClientId();
  try {
    storage?.setItem(CLIENT_ID_KEY, id);
  } catch {
    // Private mode: the id just won't persist (the address rotates next load).
  }
  return id;
}
