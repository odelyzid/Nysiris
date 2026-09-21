/**
 * Contacts: the local-only address book. Pure logic + localStorage; nothing
 * here ever touches the network, by construction.
 */

export interface Contact {
  name: string;
  address: string;
  inviter?: string;
  note?: string;
  addedAt: number;
}

export interface ContactStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'fly.contacts';

export function loadContacts(storage?: ContactStorage | null): Contact[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is Contact =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as Contact).name === 'string' &&
        typeof (c as Contact).address === 'string',
    );
  } catch {
    return [];
  }
}

export function saveContacts(contacts: Contact[], storage?: ContactStorage | null): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(contacts));
  } catch {
    // Private mode / quota: contacts just don't persist.
  }
}

export function defaultContactStorage(): ContactStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}
