/**
 * The shop provider address is a private link the user pastes once. It is
 * persisted locally (not a global setting) so reopening the Shop tab returns
 * to the same marketplace. The address is public by design — it is the
 * service's Nym address — but it stays on this device.
 */
import { defaultStorage, type StorageLike } from '../lib/storage.ts';

const SERVICE_KEY = 'fly.shop.service';

export function loadShopService(storage: StorageLike | null = defaultStorage()): string {
  try {
    return storage?.getItem(SERVICE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

export function saveShopService(service: string, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(SERVICE_KEY, service.trim());
  } catch {
    // Private mode: the address just resets next load.
  }
}
