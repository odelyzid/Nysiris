/**
 * Session-only HTTP authentication for clearnet and Nym documents.
 *
 * Passwords never go to `localStorage`: the store lives in memory for the
 * lifetime of the tab/app, matching the way the cookie jar is only a session
 * convenience. `WWW-Authenticate` challenges are parsed here; the shell owns
 * the prompt and calls `set()` only after the user submits it.
 */
import { b64encode } from '../lib/bytes.ts';

export interface AuthChallenge {
  /** Lowercase scheme (`basic`, `digest`, `bearer`, …). */
  scheme: string;
  /** Display form of the scheme (`Basic`, `Digest`, …). */
  label: string;
  realm: string;
}

export interface StoredCredential {
  scope: string;
  realm: string;
  username: string;
  password: string;
  savedAt: number;
}

const MAX_SCOPE_LENGTH = 512;
const MAX_FIELD_LENGTH = 1024;

/** Origin for clearnet URLs, the service address for Nym, else the raw input. */
export function authScopeFor(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  // `new URL()` treats the identity/key as userinfo for a custom scheme, so
  // keep the Nym address verbatim instead of reading `url.host`.
  if (/^nym:\/\//i.test(raw)) {
    const address = raw.slice('nym://'.length).split(/[/?#]/)[0];
    return address ? `nym://${address}`.slice(0, MAX_SCOPE_LENGTH) : '';
  }
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch {
    // Bare Nym addresses are not URLs; keep them verbatim below.
  }
  return raw.split(/[/?#]/)[0].slice(0, MAX_SCOPE_LENGTH);
}

/** Parse the first `WWW-Authenticate` challenge; null for garbage/empty. */
export function parseAuthChallenge(header: string | null | undefined): AuthChallenge | null {
  const raw = String(header ?? '').trim();
  if (!raw) return null;
  const schemeMatch = /^([A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*)/.exec(raw);
  if (!schemeMatch) return null;
  const label = schemeMatch[1];
  const scheme = label.toLowerCase();
  const realmMatch = /(?:^|[,;\s])realm\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,;\s]+))/i.exec(raw);
  let realm = realmMatch ? (realmMatch[1] ?? realmMatch[2] ?? '') : '';
  realm = realm
    .replace(/\\(["\\])/g, '$1')
    .trim()
    .slice(0, MAX_FIELD_LENGTH);
  return { scheme, label, realm };
}

/** Basic credentials are usable; Digest/NTLM need challenge-specific digests. */
export function isSupportedChallenge(challenge: AuthChallenge | null): boolean {
  return challenge?.scheme === 'basic';
}

export function basicAuthorization(username: string, password: string): string {
  return `Basic ${b64encode(new TextEncoder().encode(`${username}:${password}`))}`;
}

export class CredentialStore {
  private readonly credentials = new Map<string, StoredCredential>();
  private readonly now: () => number;
  private sequence = 0;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  set(scope: string, realm: string, username: string, password: string): void {
    const cleanScope = scope.trim().slice(0, MAX_SCOPE_LENGTH);
    if (!cleanScope) return;
    const cleanUser = String(username ?? '').slice(0, MAX_FIELD_LENGTH);
    const cleanPass = String(password ?? '').slice(0, MAX_FIELD_LENGTH);
    if (!cleanUser && !cleanPass) return;
    this.sequence += 1;
    this.credentials.set(credentialKey(cleanScope, realm), {
      scope: cleanScope,
      realm: String(realm ?? '').slice(0, MAX_FIELD_LENGTH),
      username: cleanUser,
      password: cleanPass,
      savedAt: this.now() + this.sequence / 1000,
    });
  }

  /** Exact realm first, then the most recent credentials for this scope. */
  get(scope: string, realm?: string): StoredCredential | null {
    const clean = scope.trim();
    if (!clean) return null;
    if (realm !== undefined) {
      const exact = this.credentials.get(credentialKey(clean, realm));
      if (exact) return { ...exact };
    }
    let latest: StoredCredential | null = null;
    for (const credential of this.credentials.values()) {
      if (credential.scope !== clean) continue;
      if (!latest || credential.savedAt > latest.savedAt) latest = credential;
    }
    return latest ? { ...latest } : null;
  }

  has(scope: string, realm?: string): boolean {
    return this.get(scope, realm) !== null;
  }

  authorizationFor(scope: string, realm?: string): string {
    const credential = this.get(scope, realm);
    return credential ? basicAuthorization(credential.username, credential.password) : '';
  }

  clear(scope?: string): void {
    if (scope === undefined) {
      this.credentials.clear();
      return;
    }
    const clean = scope.trim();
    for (const [key, credential] of this.credentials) {
      if (credential.scope === clean) this.credentials.delete(key);
    }
  }

  toJSON(): StoredCredential[] {
    return [...this.credentials.values()].map((credential) => ({ ...credential }));
  }

  get size(): number {
    return this.credentials.size;
  }
}

function credentialKey(scope: string, realm: string): string {
  return `${scope}\n${String(realm ?? '').toLowerCase()}`;
}
