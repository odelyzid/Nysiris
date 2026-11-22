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
  { rust: ['crates/social-format/src/limits.rs', 'MAX_POST_BYTES'], web: ['web/src/domain/limits.ts', 'MAX_POST_BYTES'], what: 'post body cap' },
  { rust: ['crates/social-format/src/limits.rs', 'MAX_DM_BYTES'], web: ['web/src/domain/limits.ts', 'MAX_DM_CIPHERTEXT_BYTES'], what: 'DM ciphertext cap' },
  { rust: ['crates/social-format/src/attach.rs', 'MAX_ATTACHMENT_BYTES'], web: ['web/src/domain/attachments.mjs', 'MAX_ATTACHMENT_BYTES'], what: 'attachment blob cap' },
  { rust: ['crates/social-format/src/attach.rs', 'MAX_ATTACHMENTS_PER_MESSAGE'], web: ['web/src/domain/attachments.mjs', 'MAX_ATTACHMENTS_PER_MESSAGE'], what: 'attachments per message' },
  { rust: ['crates/social-format/src/attach.rs', 'MAX_FILENAME_CHARS'], web: ['web/src/domain/attachments.mjs', 'MAX_FILENAME_CHARS'], what: 'attachment filename chars' },
  { rust: ['crates/social-format/src/attach.rs', 'MAX_BLOB_PART_BYTES'], web: ['web/src/domain/blobUpload.ts', 'BLOB_PART_BYTES'], what: 'attachment upload chunk size' },
  { rust: ['crates/social-format/src/attach.rs', 'MAX_BLOB_PARTS'], web: ['web/src/domain/blobUpload.ts', 'BLOB_MAX_PARTS'], what: 'attachment upload chunk count' },
  { rust: ['crates/social-format/src/attach.rs', 'ALLOWED_MIMES'], web: ['web/src/domain/attachments.mjs', 'ALLOWED_MIMES'], what: 'MIME whitelist' },
  { rust: ['crates/social-format/src/sig.rs', 'POST_DOMAIN'], web: ['web/src/domain/identity.ts', 'POST_DOMAIN'], what: 'post signature domain' },
  { rust: ['crates/social-format/src/sig.rs', 'PROFILE_DOMAIN'], web: ['web/src/domain/identity.ts', 'PROFILE_DOMAIN'], what: 'profile signature domain' },
  { rust: ['crates/portal-reputation/src/pow.rs', 'MAX_POW_BITS'], web: ['web/src/mixnet/pow.mjs', 'MAX_POW_BITS'], what: 'PoW difficulty cap' },
  { rust: ['crates/portal-reputation/src/pow.rs', 'POW_DOMAIN'], web: ['web/src/mixnet/pow.mjs', 'POW_DOMAIN'], what: 'PoW domain separator' },
  { rust: ['crates/portal-data/src/log.rs', 'LOG_ENTRY_DOMAIN'], web: ['web/src/domain/portalSync.ts', 'LOG_ENTRY_DOMAIN'], what: 'portal log-entry signature domain' },
  { rust: ['crates/portal-data/src/object.rs', 'OBJECT_DOMAIN'], web: ['web/src/domain/portalSync.ts', 'OBJECT_DOMAIN'], what: 'portal object signature domain' },
  { rust: ['crates/portal-data/src/object.rs', 'MAX_OBJECT_BYTES'], web: ['web/src/domain/portalSync.ts', 'MAX_OBJECT_BYTES'], what: 'portal object payload cap' },
  { rust: ['crates/portal-data/src/object.rs', 'MAX_KIND_LEN'], web: ['web/src/domain/portalSync.ts', 'MAX_KIND_LEN'], what: 'portal object kind length' },
  { rust: ['crates/bridge-guard/src/lib.rs', 'DEFAULT_MAX_BODY_BYTES'], web: ['web/src/mixnet/hiddenService.mjs', 'MAX_BODY_BYTES'], what: 'envelope body cap' },
  { rust: ['crates/nym-hidden-service/src/invite.rs', 'INVITE_DOMAIN'], web: ['web/src/domain/identity.ts', 'INVITE_DOMAIN'], what: 'invite signature domain' },
  { rust: ['crates/shop-format/src/limits.rs', 'MAX_TITLE_CHARS'], web: ['web/src/domain/shop.ts', 'MAX_TITLE_CHARS'], what: 'shop listing title cap' },
  { rust: ['crates/shop-format/src/limits.rs', 'MAX_DESCRIPTION_CHARS'], web: ['web/src/domain/shop.ts', 'MAX_DESCRIPTION_CHARS'], what: 'shop listing description cap' },
  { rust: ['crates/shop-format/src/limits.rs', 'MAX_NOTE_BYTES'], web: ['web/src/domain/shop.ts', 'MAX_NOTE_BYTES'], what: 'shop order note cap' },
  { rust: ['crates/shop-format/src/limits.rs', 'MAX_MESSAGE_BYTES'], web: ['web/src/domain/shop.ts', 'MAX_MESSAGE_BYTES'], what: 'shop order message cap' },
  { rust: ['crates/shop-format/src/limits.rs', 'MAX_ORDER_MESSAGES'], web: ['web/src/domain/shop.ts', 'MAX_ORDER_MESSAGES'], what: 'shop thread length cap' },
  { rust: ['crates/shop-format/src/limits.rs', 'MAX_MESSAGES_PAGE'], web: ['web/src/domain/shop.ts', 'MAX_MESSAGES_PAGE'], what: 'shop thread page cap' },
  { rust: ['crates/shop-format/src/limits.rs', 'DEFAULT_MESSAGES_PAGE'], web: ['web/src/domain/shop.ts', 'DEFAULT_MESSAGES_PAGE'], what: 'shop default thread page size' },
  { rust: ['crates/shop-format/src/limits.rs', 'MAX_REVIEW_BYTES'], web: ['web/src/domain/shop.ts', 'MAX_REVIEW_BYTES'], what: 'shop review cap' },
  { rust: ['crates/shop-format/src/limits.rs', 'MAX_ORDER_QTY'], web: ['web/src/domain/shop.ts', 'MAX_ORDER_QTY'], what: 'shop order quantity cap' },
  { rust: ['crates/shop-format/src/limits.rs', 'MAX_STOCK'], web: ['web/src/domain/shop.ts', 'MAX_STOCK'], what: 'shop stock cap' },
  { rust: ['crates/shop-format/src/limits.rs', 'MAX_LISTINGS_PAGE'], web: ['web/src/domain/shop.ts', 'MAX_LISTINGS_PAGE'], what: 'shop listings page cap' },
  { rust: ['crates/shop-format/src/limits.rs', 'DEFAULT_LISTINGS_PAGE'], web: ['web/src/domain/shop.ts', 'DEFAULT_LISTINGS_PAGE'], what: 'shop default page size' },
  { rust: ['crates/shop-format/src/limits.rs', 'CURRENCY_LEN'], web: ['web/src/domain/shop.ts', 'CURRENCY_LEN'], what: 'shop currency code length' },
  { rust: ['crates/shop-format/src/limits.rs', 'PRICE_MINOR_UNITS'], web: ['web/src/domain/shop.ts', 'PRICE_MINOR_UNITS'], what: 'shop minor-unit scale' },
  { rust: ['crates/shop-format/src/review.rs', 'MIN_RATING'], web: ['web/src/domain/shop.ts', 'MIN_RATING'], what: 'shop minimum rating' },
  { rust: ['crates/shop-format/src/review.rs', 'MAX_RATING'], web: ['web/src/domain/shop.ts', 'MAX_RATING'], what: 'shop maximum rating' },
  { rust: ['crates/shop-format/src/sig.rs', 'LISTING_DOMAIN'], web: ['web/src/domain/shop.ts', 'LISTING_DOMAIN'], what: 'shop listing domain' },
  { rust: ['crates/shop-format/src/sig.rs', 'LISTING_DELETE_DOMAIN'], web: ['web/src/domain/shop.ts', 'LISTING_DELETE_DOMAIN'], what: 'shop listing-delete domain' },
  { rust: ['crates/shop-format/src/sig.rs', 'ORDER_DOMAIN'], web: ['web/src/domain/shop.ts', 'ORDER_DOMAIN'], what: 'shop order domain' },
  { rust: ['crates/shop-format/src/sig.rs', 'ORDER_STATUS_DOMAIN'], web: ['web/src/domain/shop.ts', 'ORDER_STATUS_DOMAIN'], what: 'shop order-status domain' },
  { rust: ['crates/shop-format/src/sig.rs', 'ORDERS_READ_DOMAIN'], web: ['web/src/domain/shop.ts', 'ORDERS_READ_DOMAIN'], what: 'shop orders-read domain' },
  { rust: ['crates/shop-format/src/sig.rs', 'ORDER_MESSAGE_DOMAIN'], web: ['web/src/domain/shop.ts', 'ORDER_MESSAGE_DOMAIN'], what: 'shop order-message domain' },
  { rust: ['crates/shop-format/src/sig.rs', 'REVIEW_DOMAIN'], web: ['web/src/domain/shop.ts', 'REVIEW_DOMAIN'], what: 'shop review domain' },
  { rust: ['crates/escrow-format/src/limits.rs', 'MAX_ESCROW_ATOMIC'], web: ['web/src/domain/escrow.ts', 'MAX_ESCROW_ATOMIC'], what: 'escrow atomic cap' },
  { rust: ['crates/escrow-format/src/limits.rs', 'MAX_BLOB_BYTES'], web: ['web/src/domain/escrow.ts', 'MAX_BLOB_BYTES'], what: 'escrow multisig blob cap' },
  { rust: ['crates/escrow-format/src/limits.rs', 'MAX_ENVELOPE_BYTES'], web: ['web/src/domain/escrow.ts', 'MAX_ENVELOPE_BYTES'], what: 'escrow envelope cap' },
  { rust: ['crates/escrow-format/src/limits.rs', 'MAX_PROOF_BYTES'], web: ['web/src/domain/escrow.ts', 'MAX_PROOF_BYTES'], what: 'escrow proof cap' },
  { rust: ['crates/escrow-format/src/limits.rs', 'MAX_ADDRESS_BYTES'], web: ['web/src/domain/escrow.ts', 'MAX_ADDRESS_BYTES'], what: 'escrow address cap' },
  { rust: ['crates/escrow-format/src/limits.rs', 'MAX_BODY_BYTES'], web: ['web/src/domain/escrow.ts', 'MAX_BODY_BYTES'], what: 'escrow dispute body cap' },
  { rust: ['crates/escrow-format/src/limits.rs', 'MAX_SEQ'], web: ['web/src/domain/escrow.ts', 'MAX_SEQ'], what: 'escrow sequence bound' },
  { rust: ['crates/escrow-format/src/limits.rs', 'DAY_SKEW'], web: ['web/src/domain/escrow.ts', 'DAY_SKEW'], what: 'escrow day skew' },
  { rust: ['crates/escrow-format/src/limits.rs', 'FUNDING_DAYS'], web: ['web/src/domain/escrow.ts', 'FUNDING_DAYS'], what: 'escrow funding window' },
  { rust: ['crates/escrow-format/src/limits.rs', 'XMR_ATOMIC_UNITS'], web: ['web/src/domain/escrow.ts', 'XMR_ATOMIC_UNITS'], what: 'XMR atomic-unit scale' },
  { rust: ['crates/escrow-format/src/message.rs', 'OPEN_DOMAIN'], web: ['web/src/domain/escrow.ts', 'OPEN_DOMAIN'], what: 'escrow open domain' },
  { rust: ['crates/escrow-format/src/message.rs', 'JOIN_DOMAIN'], web: ['web/src/domain/escrow.ts', 'JOIN_DOMAIN'], what: 'escrow join domain' },
  { rust: ['crates/escrow-format/src/message.rs', 'COMMIT_DOMAIN'], web: ['web/src/domain/escrow.ts', 'COMMIT_DOMAIN'], what: 'escrow commit domain' },
  { rust: ['crates/escrow-format/src/message.rs', 'FUNDED_DOMAIN'], web: ['web/src/domain/escrow.ts', 'FUNDED_DOMAIN'], what: 'escrow funded domain' },
  { rust: ['crates/escrow-format/src/message.rs', 'RELEASE_DOMAIN'], web: ['web/src/domain/escrow.ts', 'RELEASE_DOMAIN'], what: 'escrow release domain' },
  { rust: ['crates/escrow-format/src/message.rs', 'APPROVE_DOMAIN'], web: ['web/src/domain/escrow.ts', 'APPROVE_DOMAIN'], what: 'escrow approve domain' },
  { rust: ['crates/escrow-format/src/message.rs', 'DISPUTE_DOMAIN'], web: ['web/src/domain/escrow.ts', 'DISPUTE_DOMAIN'], what: 'escrow dispute domain' },
  { rust: ['crates/escrow-format/src/message.rs', 'RESOLVE_DOMAIN'], web: ['web/src/domain/escrow.ts', 'RESOLVE_DOMAIN'], what: 'escrow resolve domain' },
  { rust: ['crates/escrow-format/src/message.rs', 'CANCEL_DOMAIN'], web: ['web/src/domain/escrow.ts', 'CANCEL_DOMAIN'], what: 'escrow cancel domain' },
  { rust: ['crates/escrow-format/src/message.rs', 'SUBMITTED_DOMAIN'], web: ['web/src/domain/escrow.ts', 'SUBMITTED_DOMAIN'], what: 'escrow submitted domain' },
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