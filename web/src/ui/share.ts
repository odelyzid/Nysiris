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

/** True when a thread key addresses a saved contact rather than a live sender tag. */
export function isContactThread(key: string): boolean {
  return key.startsWith('contact:');
}

/** The address embedded in a `contact:` thread key ('' for non-contact keys). */
export function contactAddressOf(key: string): string {
  return key.startsWith('contact:') ? key.slice('contact:'.length) : '';
}

/**
 * The inbox's thread keys, in first-seen order: one key per distinct sender
 * tag (falling back to a per-index direct key), then one `contact:` key per
 * saved contact so a contact always starts a thread. Never mutates inputs.
 */
export function buildInboxThreads(inbox: { senderTag?: string }[], contacts: { address: string }[]): string[] {
  const keys: string[] = [];
  inbox.forEach((m, i) => {
    const key = threadKeyFor(m, i);
    if (!keys.includes(key)) keys.push(key);
  });
  for (const c of contacts) {
    const key = `contact:${c.address}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Unread count for a thread, never negative (missing read watermark = 0). */
export function threadUnread(total: number, read: number): number {
  return Math.max(0, total - read);
}

/**
 * Displayable form of a fetched provider body: JSON is pretty-printed, other
 * text is truncated to `maxChars`. HTML bodies are NOT reformatted here —
 * they are sandboxed and rendered as-is by the caller.
 */
export function formatFetchedBody(text: string, contentType: string, maxChars = 2000): string {
  let shown = text.slice(0, maxChars);
  if (contentType.includes('json')) {
    try {
      shown = JSON.stringify(JSON.parse(text), null, 2).slice(0, maxChars);
    } catch {
      // Not valid JSON: keep the raw text.
    }
  }
  return shown;
}
