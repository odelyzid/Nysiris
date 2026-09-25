/**
 * Everyday address helpers: short labels, private links, clipboard.
 *
 * The main UI never shows a full `nym://identity.encryption@gateway`
 * address. It shows a petname when one exists, otherwise a short
 * `ABC123…XYZ9` label. Full values live behind "Show technical details"
 * or in Settings → Advanced. Pure logic, tested with
 * `node --test web/test`.
 */

/** `ABCDEF...XYZ` → `ABCD…WXYZ`. Never throws; short inputs pass through. */
export function shortenAddress(address: string, head = 6, tail = 4): string {
  const s = String(address ?? '').trim();
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Ensure the `nym://` scheme is present for sharing/copying. */
export function toPrivateLink(address: string): string {
  const s = String(address ?? '').trim();
  if (!s) return '';
  return s.startsWith('nym://') ? s : `nym://${s}`;
}

/** Primary label: petname when known, otherwise the short address. */
export function displayLabel(address: string, petname?: string | null): string {
  const name = String(petname ?? '').trim();
  if (name) return name;
  return shortenAddress(address);
}

/** Find a petname for an address in the local address book. */
export function petnameFor(address: string, contacts: { name: string; address: string }[]): string | null {
  const want = toPrivateLink(address).toLowerCase();
  for (const c of contacts) {
    if (toPrivateLink(c.address).toLowerCase() === want) return c.name;
    // Also match bare-vs-schemed variants.
    if (
      c.address.trim().toLowerCase() ===
      String(address ?? '')
        .trim()
        .toLowerCase()
    )
      return c.name;
  }
  return null;
}

/**
 * Copy text to the clipboard. Uses `navigator.clipboard` when available,
 * falling back to `false` so the caller can select-and-copy manually.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * DM thread keys and labels for the inbox, shared by the messages view and
 * the desktop roster. Structural types keep this module import-free (repo
 * convention for `node --test` modules).
 */
export function threadKeyFor(msg: { senderTag?: string }, index: number): string {
  return msg.senderTag ? `tag:${msg.senderTag}` : `direct:${index}`;
}

export function threadLabel(key: string, contacts: { name: string; address: string }[]): string {
  if (key.startsWith('contact:')) {
    const address = key.slice('contact:'.length);
    return displayLabel(address, petnameFor(address, contacts));
  }
  if (key.startsWith('tag:')) return `Chat ${shortenAddress(key.slice(4))}`;
  return 'Chat';
}
