/**
 * Pure hidden-service envelope helpers.
 *
 * No browser globals, no base64 here (callers convert bytes outside): the
 * envelope carries the body as an opaque base64 string. Tested with
 * `node --test web/test` — no bundler, no npm install.
 *
 * Mirrors `crates/nym-hidden-service/src/envelope.rs`.
 * Security: docs/05-security.md §5.10 (open-proxy guards).
 */

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Validate a request path the same way bridge-guard does.
 * @param {unknown} path
 * @returns {string} the trimmed path
 * @throws {Error} on traversal, absolute URLs, backslashes, encoded tricks
 */
export function checkPath(path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('path must be a non-empty string');
  const p = path.trim();
  if (!p.startsWith('/')) throw new Error(`path must be rooted, got ${JSON.stringify(path)}`);
  if (p.startsWith('//')) throw new Error('protocol-relative paths are not allowed');
  if (p.includes('\\')) throw new Error('backslashes are not allowed in paths');
  const lowered = p.toLowerCase();
  if (lowered.includes('..') || lowered.includes('%2e') || lowered.includes('%2f') || lowered.includes('%5c')) {
    throw new Error(`path traversal is not allowed: ${JSON.stringify(path)}`);
  }
  return p;
}

/**
 * Encode a request envelope. `bodyBase64` must already be base64 (may be '').
 * @param {{ method?: string, path: string, headers?: Record<string,string>, bodyBase64?: string }} req
 * @returns {string} JSON envelope
 */
export function encodeRequest(req) {
  const method = String(req?.method ?? 'GET').trim().toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw new Error(`method ${JSON.stringify(req?.method)} is not allowed`);
  const path = checkPath(req?.path);
  const headers = req?.headers ?? {};
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('headers must be an object');
  }
  const bodyBase64 = req?.bodyBase64 ?? '';
  if (typeof bodyBase64 !== 'string') throw new Error('bodyBase64 must be a string');
  // Approximate the 64 KiB cap without decoding: 4 base64 chars ~= 3 bytes.
  if (Math.ceil((bodyBase64.length * 3) / 4) > MAX_BODY_BYTES) {
    throw new Error('request body exceeds the 64 KiB cap');
  }
  const out = { method, path, headers: { ...headers }, body_base64: bodyBase64 };
  return JSON.stringify(out);
}

/**
 * Decode and validate a response envelope.
 * @param {string} json
 * @returns {{ status: number, headers: Record<string,string>, bodyBase64: string, error: string | null }}
 */
export function decodeResponse(json) {
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error('response is not valid JSON');
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('response envelope must be an object');
  }
  const status = obj.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error('response has no valid status');
  }
  if (obj.headers !== undefined && (obj.headers === null || typeof obj.headers !== 'object' || Array.isArray(obj.headers))) {
    throw new Error('response headers must be an object');
  }
  if (typeof obj.body_base64 !== 'string') throw new Error('response has no body_base64 string');
  if (obj.error !== undefined && obj.error !== null && typeof obj.error !== 'string') {
    throw new Error('response error must be a string or null');
  }
  return {
    status,
    headers: { ...(obj.headers ?? {}) },
    bodyBase64: obj.body_base64,
    error: obj.error ?? null,
  };
}

/**
 * Parse a hidden-service address of the form `nym://id.enc@gw` or bare `id.enc@gw`.
 * Shape-checked only (3 non-empty parts); key decoding happens in the SDKs.
 * @param {string} input
 * @returns {{ identity: string, encryption: string, gateway: string }}
 */
export function parseNymAddress(input) {
  if (typeof input !== 'string') throw new Error('address must be a string');
  const rest = input.trim().startsWith('nym://') ? input.trim().slice('nym://'.length) : input.trim();
  const at = rest.split('@');
  if (at.length !== 2 || !at[0] || !at[1]) throw new Error('expected nym://<identity>.<encryption>@<gateway>');
  const dot = at[0].split('.');
  // Base58 has no '.' or '@', so exactly one of each separator is allowed.
  if (dot.length !== 2 || !dot[0] || !dot[1] || at[1].includes('.')) {
    throw new Error('expected nym://<identity>.<encryption>@<gateway>');
  }
  return { identity: dot[0], encryption: dot[1], gateway: at[1] };
}

/**
 * Split a pasted hidden-service locator into address + path.
 *
 * Accepts `nym://id.enc@gw/path`, bare `id.enc@gw/path`, or a bare address
 * (path defaults to `/`). Fragments are dropped; queries are kept.
 *
 * @param {string} input
 * @returns {{ address: string, path: string }}
 */
export function splitNymUri(input) {
  if (typeof input !== 'string') throw new Error('address must be a string');
  let s = input.trim();
  if (s.startsWith('nym://')) s = s.slice('nym://'.length);
  const slash = s.indexOf('/');
  const addrPart = slash === -1 ? s : s.slice(0, slash);
  let path = slash === -1 ? '/' : s.slice(slash);
  const hash = path.indexOf('#');
  if (hash !== -1) path = path.slice(0, hash) || '/';
  parseNymAddress(addrPart); // throws on garbage
  checkPath(path);
  return { address: addrPart, path };
}

/**
 * Minimal base58 decode (Bitcoin alphabet — same as the `bs58` Rust crate).
 * Needed to verify invite signatures without pulling a dependency.
 * @param {string} s
 * @returns {Uint8Array} exactly the decoded bytes (caller checks length)
 */
export function base58Decode(s) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (typeof s !== 'string' || s.length === 0) throw new Error('base58 input must be a non-empty string');
  let num = 0n;
  for (const ch of s) {
    const digit = ALPHABET.indexOf(ch);
    if (digit === -1) throw new Error(`invalid base58 character: ${JSON.stringify(ch)}`);
    num = num * 58n + BigInt(digit);
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  // Leading '1's are leading zero bytes.
  let leading = 0;
  for (const ch of s) {
    if (ch !== '1') break;
    leading += 1;
  }
  return new Uint8Array([...new Array(leading).fill(0), ...bytes]);
}

function b64urlDecodeToString(compact) {
  const b64 = compact.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (compact.length % 4)) % 4);
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function b64urlEncodeString(text) {
  let b64;
  if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(text, 'utf8').toString('base64');
  } else {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    b64 = btoa(bin);
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode an invite compact string to its JSON fields (shape-checked only;
 * signature verification lives in `identity.ts`, which has noble).
 * @param {string} compact
 * @returns {{ service: string, inviter: string, note: string, sig: string, vouches?: string[] }}
 */
export function decodeInviteCompact(compact) {
  if (typeof compact !== 'string' || !/^[A-Za-z0-9_-]+$/.test(compact)) {
    throw new Error('invite is not valid base64url');
  }
  let obj;
  try {
    obj = JSON.parse(b64urlDecodeToString(compact));
  } catch {
    throw new Error('invite does not decode to JSON');
  }
  for (const field of ['service', 'inviter', 'note', 'sig']) {
    if (typeof obj?.[field] !== 'string' || obj[field].length === 0) {
      throw new Error(`invite is missing ${field}`);
    }
  }
  if (obj.note.length > 140) throw new Error('invite note too long');
  // Vouches are optional; when present they must be a short list of pubkeys.
  // Mirror of MAX_INVITE_VOUCHES in `social/identity.ts`.
  if (obj.vouches !== undefined) {
    if (
      !Array.isArray(obj.vouches) ||
      obj.vouches.length > 8 ||
      obj.vouches.some((v) => typeof v !== 'string' || !/^[0-9a-f]{64}$/i.test(v))
    ) {
      throw new Error('invite vouches must be up to 8 pubkey hex strings');
    }
  }
  parseNymAddress(obj.service); // shape-check the inner address
  const out = { service: obj.service, inviter: obj.inviter, note: obj.note, sig: obj.sig };
  if (obj.vouches !== undefined) out.vouches = [...obj.vouches];
  return out;
}

/**
 * Encode invite fields to the compact link-fragment form.
 * @param {{ service: string, inviter: string, note: string, sig: string, vouches?: string[] }} invite
 * @returns {string}
 */
export function encodeInviteCompact(invite) {
  const decoded = decodeInviteCompact(
    b64urlEncodeString(JSON.stringify(invite)),
  );
  void decoded;
  return b64urlEncodeString(JSON.stringify(invite));
}

/**
 * @typedef {{ service: string, inviter: string, note: string, sig: string, vouches?: string[] }} InviteFields
 */
/**
 * Parse a full locator: `nym://addr/path#invite=...`, bare `addr#invite=...`,
 * or plain addresses/paths (invite is then null). The fragment never goes on
 * the wire — it authenticates the introducer to the recipient, client-side.
 * @param {string} input
 * @returns {{ address: string, path: string, invite: InviteFields | null }}
 */
export function parseInviteLink(input) {
  if (typeof input !== 'string') throw new Error('address must be a string');
  const s = input.trim();
  const hash = s.indexOf('#');
  const main = hash === -1 ? s : s.slice(0, hash);
  const frag = hash === -1 ? '' : s.slice(hash + 1);
  const { address, path } = splitNymUri(main);
  let invite = null;
  if (frag) {
    const m = /^invite=([A-Za-z0-9_-]+)$/.exec(frag);
    if (!m) throw new Error('unrecognised URI fragment (expected #invite=...)');
    invite = decodeInviteCompact(m[1]);
    // Bait-and-switch check, client-side: the invite must name this address.
    const inner = parseNymAddress(invite.service);
    const outer = parseNymAddress(address);
    if (inner.identity !== outer.identity || inner.encryption !== outer.encryption || inner.gateway !== outer.gateway) {
      throw new Error('invite names a different service than the link');
    }
  }
  return { address, path, invite };
}

/**
 * Resolve a petname against a local registry, falling back to direct parsing.
 * The registry is caller-owned and never leaves the machine.
 * @param {string} input
 * @param {Record<string,string>} [registry]
 * @returns {string} a full address string
 */
export function resolvePetname(input, registry = {}) {
  const key = String(input ?? '').trim().toLowerCase();
  if (key && Object.prototype.hasOwnProperty.call(registry, key)) return registry[key];
  parseNymAddress(input); // throws on garbage
  return String(input).trim();
}
