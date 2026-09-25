// Constraint drift check: ensures the web client's copy of the wire
// constants stays byte-equal to the Rust crates. Used by ./build.sh check.
//
// The Rust crate declarations are the source of truth (they gate the
// provider). If a boundary constant changes there, this script fails until
// the mirrored file is updated — so a change to one side of the wire can
// never silently drift from the other.
//
// Covers only constants confirmed mirrored on both sides today; do not add
// rows for things with no counterpart (the check would fail).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pairs = [
  { rust: ['crates/social-format/src/limits.rs', 'MAX_POST_BYTES'], web: ['web/src/social/limits.ts', 'MAX_POST_BYTES'], what: 'post body cap' },
  { rust: ['crates/social-format/src/limits.rs', 'MAX_DM_BYTES'], web: ['web/src/social/limits.ts', 'MAX_DM_CIPHERTEXT_BYTES'], what: 'DM ciphertext cap' },
  { rust: ['crates/social-format/src/attach.rs', 'MAX_ATTACHMENT_BYTES'], web: ['web/src/social/attachments.mjs', 'MAX_ATTACHMENT_BYTES'], what: 'attachment blob cap' },
  { rust: ['crates/social-format/src/attach.rs', 'MAX_ATTACHMENTS_PER_MESSAGE'], web: ['web/src/social/attachments.mjs', 'MAX_ATTACHMENTS_PER_MESSAGE'], what: 'attachments per message' },
  { rust: ['crates/social-format/src/attach.rs', 'MAX_FILENAME_CHARS'], web: ['web/src/social/attachments.mjs', 'MAX_FILENAME_CHARS'], what: 'attachment filename chars' },
  { rust: ['crates/social-format/src/attach.rs', 'MAX_BLOB_PART_BYTES'], web: ['web/src/social/attachmentUi.tsx', 'BLOB_PART_BYTES'], what: 'attachment upload chunk size' },
  { rust: ['crates/social-format/src/attach.rs', 'MAX_BLOB_PARTS'], web: ['web/src/social/attachmentUi.tsx', 'BLOB_MAX_PARTS'], what: 'attachment upload chunk count' },
  { rust: ['crates/social-format/src/attach.rs', 'ALLOWED_MIMES'], web: ['web/src/social/attachments.mjs', 'ALLOWED_MIMES'], what: 'MIME whitelist' },
  { rust: ['crates/social-format/src/sig.rs', 'POST_DOMAIN'], web: ['web/src/social/identity.ts', 'POST_DOMAIN'], what: 'post signature domain' },
  { rust: ['crates/social-format/src/sig.rs', 'PROFILE_DOMAIN'], web: ['web/src/social/identity.ts', 'PROFILE_DOMAIN'], what: 'profile signature domain' },
  { rust: ['crates/portal-reputation/src/pow.rs', 'MAX_POW_BITS'], web: ['web/src/mixnet/pow.mjs', 'MAX_POW_BITS'], what: 'PoW difficulty cap' },
  { rust: ['crates/portal-reputation/src/pow.rs', 'POW_DOMAIN'], web: ['web/src/mixnet/pow.mjs', 'POW_DOMAIN'], what: 'PoW domain separator' },
  { rust: ['crates/portal-data/src/log.rs', 'LOG_ENTRY_DOMAIN'], web: ['web/src/social/portalSync.ts', 'LOG_ENTRY_DOMAIN'], what: 'portal log-entry signature domain' },
  { rust: ['crates/portal-data/src/object.rs', 'OBJECT_DOMAIN'], web: ['web/src/social/portalSync.ts', 'OBJECT_DOMAIN'], what: 'portal object signature domain' },
  { rust: ['crates/portal-data/src/object.rs', 'MAX_OBJECT_BYTES'], web: ['web/src/social/portalSync.ts', 'MAX_OBJECT_BYTES'], what: 'portal object payload cap' },
  { rust: ['crates/portal-data/src/object.rs', 'MAX_KIND_LEN'], web: ['web/src/social/portalSync.ts', 'MAX_KIND_LEN'], what: 'portal object kind length' },
  { rust: ['crates/bridge-guard/src/lib.rs', 'DEFAULT_MAX_BODY_BYTES'], web: ['web/src/mixnet/hiddenService.mjs', 'MAX_BODY_BYTES'], what: 'envelope body cap' },
  { rust: ['crates/nym-hidden-service/src/invite.rs', 'INVITE_DOMAIN'], web: ['web/src/social/identity.ts', 'INVITE_DOMAIN'], what: 'invite signature domain' },
];

function readRel(rel) {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch (err) {
    throw new Error(`unreadable ${rel}: ${err.message}`);
  }
}

function constRhs(src, name) {
  const re = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*([^;]+);`);
  const m = re.exec(src);
  if (!m) throw new Error(`constant ${name} not found`);
  return m[1].trim();
}

function unescape(s) {
  return s.replace(/\\(.)/g, '$1');
}

function evalNumberOrString(expr) {
  let m;
  if ((m = /^b"([^"]*)"/.exec(expr)) || (m = /^"([^"]*)"/.exec(expr))) {
    return { kind: 'str', value: unescape(m[1]) };
  }
  if ((m = /^'([^']*)'/.exec(expr))) {
    return { kind: 'str', value: m[1] };
  }
  if (/^[0-9_]+(\s*\*\s*[0-9_]+)*$/.test(expr)) {
    const value = expr
      .split('*')
      .reduce((acc, t) => acc * Number(t.replace(/_/g, '').trim()), 1);
    return { kind: 'num', value };
  }
  return null;
}

function evalList(expr) {
  // ALLOWED_MIMES-style: Object.freeze([ 'a', 'b' ]) or [&str; N] = [ ... ] / &["..."].
  let body = expr.trim();
  const freeze = /^Object\.freeze\((\[[\s\S]*\])\)$/.exec(body);
  if (freeze) body = freeze[1];
  if (body.startsWith('&[')) body = body.slice(1);
  if (!body.startsWith('[')) return null;
  const items = [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => unescape(m[1] ?? m[2]));
  if (items.length === 0) return null;
  return { kind: 'list', value: items };
}

function evalConst(src, name) {
  const rhs = constRhs(src, name);
  return evalNumberOrString(rhs) ?? evalList(rhs) ?? (() => { throw new Error(`unsupported expression for ${name}: ${rhs}`); })();
}

function same(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'num') return a.value === b.value;
  if (a.kind === 'str') return a.value === b.value;
  return a.value.length === b.value.length && a.value.every((v, i) => v === b.value[i]);
}

let failures = 0;
for (const { rust, web, what } of pairs) {
  const [rustFile, rustName] = rust;
  const [webFile, webName] = web;
  try {
    const r = evalConst(readRel(rustFile), rustName);
    const w = evalConst(readRel(webFile), webName);
    if (!same(r, w)) {
      console.error(`constant drift: ${what} — ${rustFile} ${rustName} is ${fmt(r)}, ${webFile} ${webName} is ${fmt(w)}`);
      failures += 1;
    }
  } catch (err) {
    console.error(`constant check: ${what}: ${err.message}`);
    failures += 1;
  }
}

function fmt(v) {
  if (v.kind === 'list') return JSON.stringify(v.value);
  if (v.kind === 'str') return JSON.stringify(v.value);
  return String(v.value);
}

if (failures > 0) {
  console.error(`${failures} constant drift(s) — keep Rust and web in step (change the crate first)`);
  process.exit(1);
}
console.log(`constants ok (${pairs.length} pairs)`);