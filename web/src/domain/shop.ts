/**
 * Marketplace wire grammar for nysiris-shop — byte-exact mirror of
 * `crates/shop-format/src/sig.rs`, `pow.rs`, `status.rs`, `review.rs`, and
 * `limits.rs` (provider: `services/shop`, design: `docs/16-shop.md`).
 *
 * Every write is an ed25519 signature over a domain-separated message. The
 * provider verifies before storing, and clients re-verify what they read.
 * Keep field order and integer widths identical to Rust: fixed-size fields
 * first, variable payload last, u64/u32 big-endian, no length prefixes.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { u64be } from '../lib/bytes.ts';

export const LISTING_DOMAIN = 'fly-shop-v1/listing';
export const LISTING_DELETE_DOMAIN = 'fly-shop-v1/listing-delete';
export const ORDER_DOMAIN = 'fly-shop-v1/order';
export const ORDER_STATUS_DOMAIN = 'fly-shop-v1/order-status';
export const ORDERS_READ_DOMAIN = 'fly-shop-v1/orders-read';
export const ORDER_MESSAGE_DOMAIN = 'fly-shop-v1/order-message';
export const REVIEW_DOMAIN = 'fly-shop-v1/review';

/** Mirror of `shop_format::limits` (checked by scripts/check-constants.mjs). */
export const MAX_TITLE_CHARS = 80;
export const MAX_DESCRIPTION_CHARS = 1200;
export const MAX_NOTE_BYTES = 500;
export const MAX_MESSAGE_BYTES = 1000;
export const MAX_ORDER_MESSAGES = 500;
export const MAX_MESSAGES_PAGE = 50;
export const DEFAULT_MESSAGES_PAGE = 20;
export const MAX_REVIEW_BYTES = 600;
export const MAX_ORDER_QTY = 1_000;
export const MAX_STOCK = 1_000_000;
export const MAX_LISTINGS_PAGE = 50;
export const DEFAULT_LISTINGS_PAGE = 20;
export const CURRENCY_LEN = 3;
export const PRICE_MINOR_UNITS = 100;

/** Mirror of `shop_format::review` bounds. */
export const MIN_RATING = 1;
export const MAX_RATING = 5;

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

/** Coarse UTC day number — same source of time as `sig::current_day`. */
export function currentDay(): number {
  return Math.floor(Date.now() / 1000 / 86_400);
}

function assertU64(n: number, label: string): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${label} must be a non-negative integer`);
  return n;
}

function assertU32(n: number, label: string): number {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new Error(`${label} must be a u32`);
  return n;
}

function assertByte(n: number, label: string): number {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new Error(`${label} must be a single byte`);
  return n;
}

function idBytes(idHex: string, label = 'id'): Uint8Array {
  const clean = idHex.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(clean)) throw new Error(`${label} must be a 16-byte id in hex`);
  return hexToBytes(clean);
}

function keyBytes(keyHex: string, label = 'key'): Uint8Array {
  const clean = keyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error(`${label} must be a 32-byte key in hex`);
  return hexToBytes(clean);
}

function sigBytes(sigHex: string): Uint8Array {
  const clean = sigHex.trim().toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(clean)) throw new Error('signature must be 64 bytes in hex');
  return hexToBytes(clean);
}

/** A fresh random 16-byte listing/order id. Unlinkable handles, never counters. */
export function newIdHex(): string {
  return bytesToHex(randomBytes(16));
}

/** Fixed three-letter uppercase currency code, exactly as the provider parses it. */
export function isCurrencyCode(currency: string): boolean {
  return /^[A-Z]{3}$/.test(currency);
}

function listingBytes(
  sellerHex: string,
  day: number,
  idHex: string,
  version: number,
  price: number,
  stock: number,
  currency: string,
  title: string,
  description: string,
): Uint8Array {
  if (!isCurrencyCode(currency)) throw new Error('currency must be a 3-letter uppercase code');
  return concat(
    enc.encode(LISTING_DOMAIN),
    keyBytes(sellerHex, 'seller'),
    u64be(assertU64(day, 'day')),
    idBytes(idHex),
    u64be(assertU64(version, 'version')),
    u64be(assertU64(price, 'price')),
    u32be(assertU32(stock, 'stock')),
    enc.encode(currency),
    enc.encode(title),
    new Uint8Array([0]),
    enc.encode(description),
  );
}

/** Sign `POST /listing`: seller || day || id || version || price || stock || currency || title || 0x00 || description. */
export function signListing(
  privHex: string,
  sellerHex: string,
  day: number,
  idHex: string,
  version: number,
  price: number,
  stock: number,
  currency: string,
  title: string,
  description: string,
): string {
  const msg = listingBytes(sellerHex, day, idHex, version, price, stock, currency, title, description);
  return bytesToHex(ed25519.sign(msg, keyBytes(privHex, 'private key')));
}

/** Re-verify a listing before trusting its seller, price, or stock. */
export function verifyListingSignature(
  sellerHex: string,
  day: number,
  idHex: string,
  version: number,
  price: number,
  stock: number,
  currency: string,
  title: string,
  description: string,
  sigHex: string,
): boolean {
  try {
    const msg = listingBytes(sellerHex, day, idHex, version, price, stock, currency, title, description);
    return ed25519.verify(sigBytes(sigHex), msg, keyBytes(sellerHex, 'seller'));
  } catch {
    return false;
  }
}

function listingDeleteBytes(sellerHex: string, idHex: string, day: number): Uint8Array {
  return concat(
    enc.encode(LISTING_DELETE_DOMAIN),
    keyBytes(sellerHex, 'seller'),
    idBytes(idHex),
    u64be(assertU64(day, 'day')),
  );
}

export function signListingDelete(privHex: string, sellerHex: string, idHex: string, day: number): string {
  return bytesToHex(ed25519.sign(listingDeleteBytes(sellerHex, idHex, day), keyBytes(privHex, 'private key')));
}

export function verifyListingDeleteSignature(
  sellerHex: string,
  idHex: string,
  day: number,
  sigHex: string,
): boolean {
  try {
    return ed25519.verify(sigBytes(sigHex), listingDeleteBytes(sellerHex, idHex, day), keyBytes(sellerHex, 'seller'));
  } catch {
    return false;
  }
}

function orderBytes(
  buyerHex: string,
  day: number,
  listingHex: string,
  idHex: string,
  qty: number,
  price: number,
  version: number,
  note: string,
): Uint8Array {
  return concat(
    enc.encode(ORDER_DOMAIN),
    keyBytes(buyerHex, 'buyer'),
    u64be(assertU64(day, 'day')),
    idBytes(listingHex, 'listing'),
    idBytes(idHex),
    u32be(assertU32(qty, 'qty')),
    u64be(assertU64(price, 'price')),
    u64be(assertU64(version, 'version')),
    enc.encode(note),
  );
}

/** Sign `POST /order`: buyer || day || listing || id || qty || price || version || note. */
export function signOrder(
  privHex: string,
  buyerHex: string,
  day: number,
  listingHex: string,
  idHex: string,
  qty: number,
  price: number,
  version: number,
  note: string,
): string {
  return bytesToHex(
    ed25519.sign(
      orderBytes(buyerHex, day, listingHex, idHex, qty, price, version, note),
      keyBytes(privHex, 'private key'),
    ),
  );
}

export function verifyOrderSignature(
  buyerHex: string,
  day: number,
  listingHex: string,
  idHex: string,
  qty: number,
  price: number,
  version: number,
  note: string,
  sigHex: string,
): boolean {
  try {
    return ed25519.verify(
      sigBytes(sigHex),
      orderBytes(buyerHex, day, listingHex, idHex, qty, price, version, note),
      keyBytes(buyerHex, 'buyer'),
    );
  } catch {
    return false;
  }
}

function orderStatusBytes(actorHex: string, day: number, orderHex: string, status: number, note: string): Uint8Array {
  return concat(
    enc.encode(ORDER_STATUS_DOMAIN),
    keyBytes(actorHex, 'actor'),
    u64be(assertU64(day, 'day')),
    idBytes(orderHex, 'order'),
    new Uint8Array([assertByte(status, 'status')]),
    enc.encode(note),
  );
}

/** Sign `POST /order/<id>/status`: actor || day || order || status(1) || note. */
export function signOrderStatus(
  privHex: string,
  actorHex: string,
  day: number,
  orderHex: string,
  status: number,
  note: string,
): string {
  return bytesToHex(
    ed25519.sign(orderStatusBytes(actorHex, day, orderHex, status, note), keyBytes(privHex, 'private key')),
  );
}

export function verifyOrderStatusSignature(
  actorHex: string,
  day: number,
  orderHex: string,
  status: number,
  note: string,
  sigHex: string,
): boolean {
  try {
    return ed25519.verify(
      sigBytes(sigHex),
      orderStatusBytes(actorHex, day, orderHex, status, note),
      keyBytes(actorHex, 'actor'),
    );
  } catch {
    return false;
  }
}

function ordersReadBytes(forHex: string, day: number): Uint8Array {
  return concat(enc.encode(ORDERS_READ_DOMAIN), keyBytes(forHex, 'for'), u64be(assertU64(day, 'day')));
}

/**
 * Proof of possession for the private order list: `for || day`. The buyer and
 * seller keys are public, so `GET /orders` must not be readable without them.
 */
export function signOrdersRead(privHex: string, forHex: string, day: number): string {
  return bytesToHex(ed25519.sign(ordersReadBytes(forHex, day), keyBytes(privHex, 'private key')));
}

export function verifyOrdersReadSignature(forHex: string, day: number, sigHex: string): boolean {
  try {
    return ed25519.verify(sigBytes(sigHex), ordersReadBytes(forHex, day), keyBytes(forHex, 'for'));
  } catch {
    return false;
  }
}

function orderMessageBytes(authorHex: string, day: number, orderHex: string, body: string): Uint8Array {
  return concat(
    enc.encode(ORDER_MESSAGE_DOMAIN),
    keyBytes(authorHex, 'author'),
    u64be(assertU64(day, 'day')),
    idBytes(orderHex, 'order'),
    enc.encode(body),
  );
}

/** Sign `POST /order/<id>/message`: author || day || order || body. */
export function signOrderMessage(
  privHex: string,
  authorHex: string,
  day: number,
  orderHex: string,
  body: string,
): string {
  return bytesToHex(
    ed25519.sign(orderMessageBytes(authorHex, day, orderHex, body), keyBytes(privHex, 'private key')),
  );
}

export function verifyOrderMessageSignature(
  authorHex: string,
  day: number,
  orderHex: string,
  body: string,
  sigHex: string,
): boolean {
  try {
    return ed25519.verify(
      sigBytes(sigHex),
      orderMessageBytes(authorHex, day, orderHex, body),
      keyBytes(authorHex, 'author'),
    );
  } catch {
    return false;
  }
}

function reviewBytes(
  authorHex: string,
  day: number,
  orderHex: string,
  sellerHex: string,
  rating: number,
  body: string,
): Uint8Array {
  if (!isValidRating(rating)) throw new Error('rating must be 1..=5');
  return concat(
    enc.encode(REVIEW_DOMAIN),
    keyBytes(authorHex, 'author'),
    u64be(assertU64(day, 'day')),
    idBytes(orderHex, 'order'),
    keyBytes(sellerHex, 'seller'),
    new Uint8Array([rating]),
    enc.encode(body),
  );
}

/** Sign `POST /review`: author || day || order || seller || rating(1) || body. */
export function signReview(
  privHex: string,
  authorHex: string,
  day: number,
  orderHex: string,
  sellerHex: string,
  rating: number,
  body: string,
): string {
  return bytesToHex(
    ed25519.sign(
      reviewBytes(authorHex, day, orderHex, sellerHex, rating, body),
      keyBytes(privHex, 'private key'),
    ),
  );
}

export function verifyReviewSignature(
  authorHex: string,
  day: number,
  orderHex: string,
  sellerHex: string,
  rating: number,
  body: string,
  sigHex: string,
): boolean {
  try {
    return ed25519.verify(
      sigBytes(sigHex),
      reviewBytes(authorHex, day, orderHex, sellerHex, rating, body),
      keyBytes(authorHex, 'author'),
    );
  } catch {
    return false;
  }
}

// ---- PoW payload preimages (mirror shop_format::pow) ----

export function listingPowPreimage(
  idHex: string,
  version: number,
  price: number,
  stock: number,
  currency: string,
  title: string,
  description: string,
): Uint8Array {
  return concat(
    idBytes(idHex),
    u64be(assertU64(version, 'version')),
    u64be(assertU64(price, 'price')),
    u32be(assertU32(stock, 'stock')),
    enc.encode(currency),
    enc.encode(title),
    new Uint8Array([0]),
    enc.encode(description),
  );
}

export function listingDeletePowPreimage(idHex: string): Uint8Array {
  return idBytes(idHex);
}

export function orderPowPreimage(
  listingHex: string,
  idHex: string,
  qty: number,
  price: number,
  version: number,
  note: string,
): Uint8Array {
  return concat(
    idBytes(listingHex, 'listing'),
    idBytes(idHex),
    u32be(assertU32(qty, 'qty')),
    u64be(assertU64(price, 'price')),
    u64be(assertU64(version, 'version')),
    enc.encode(note),
  );
}

export function orderStatusPowPreimage(orderHex: string, status: number, note: string): Uint8Array {
  return concat(
    idBytes(orderHex, 'order'),
    new Uint8Array([assertByte(status, 'status')]),
    enc.encode(note),
  );
}

export function orderMessagePowPreimage(orderHex: string, body: string): Uint8Array {
  return concat(idBytes(orderHex, 'order'), enc.encode(body));
}

export function reviewPowPreimage(
  orderHex: string,
  sellerHex: string,
  rating: number,
  body: string,
): Uint8Array {
  return concat(
    idBytes(orderHex, 'order'),
    keyBytes(sellerHex, 'seller'),
    new Uint8Array([assertByte(rating, 'rating')]),
    enc.encode(body),
  );
}

// ---- order state machine (mirror shop_format::status) ----

export const ORDER_STATUS = {
  reserved: 0,
  accepted: 1,
  fulfilled: 2,
  declined: 3,
  cancelled: 4,
} as const;

export type OrderStatusName = keyof typeof ORDER_STATUS;

export function orderStatusName(code: number): OrderStatusName | 'unknown' {
  for (const [name, value] of Object.entries(ORDER_STATUS) as [OrderStatusName, number][]) {
    if (value === code) return name;
  }
  return 'unknown';
}

export function canTransition(role: 'buyer' | 'seller', current: number, next: number): boolean {
  if (role === 'seller') {
    return (
      (current === ORDER_STATUS.reserved && (next === ORDER_STATUS.accepted || next === ORDER_STATUS.declined)) ||
      (current === ORDER_STATUS.accepted && next === ORDER_STATUS.fulfilled)
    );
  }
  return (
    (current === ORDER_STATUS.reserved || current === ORDER_STATUS.accepted) && next === ORDER_STATUS.cancelled
  );
}

export interface StatusEventWire {
  /** Wire shape from `order_json`: numeric status codes, signed by `actor`. */
  from_code: number;
  status_code: number;
  actor: string;
  day: number;
  note: string;
  sig: string;
}

/**
 * Replay the signed transition chain from `reserved`. A provider that
 * reports a status no party signed cannot produce a chain that verifies here.
 */
export function verifyStatusChain(
  orderHex: string,
  buyerHex: string,
  sellerHex: string,
  statusCode: number,
  events: StatusEventWire[],
): boolean {
  let current: number = ORDER_STATUS.reserved;
  for (const event of events) {
    if (!Number.isInteger(event.from_code) || event.from_code !== current) return false;
    if (event.actor !== buyerHex && event.actor !== sellerHex) return false;
    if (
      !verifyOrderStatusSignature(
        event.actor,
        event.day,
        orderHex,
        event.status_code,
        event.note,
        event.sig,
      )
    ) {
      return false;
    }
    const role = event.actor === buyerHex ? 'buyer' : 'seller';
    if (!canTransition(role, current, event.status_code)) return false;
    current = event.status_code;
  }
  return current === statusCode;
}

// ---- reviews ----

export function isValidRating(rating: number): boolean {
  return Number.isInteger(rating) && rating >= MIN_RATING && rating <= MAX_RATING;
}

export interface ReviewSummary {
  count: number;
  sum: number;
  averageX100: number;
}

/** Local aggregate over verified reviews. Never a provider-published score. */
export function summarizeRatings(ratings: Iterable<number>): ReviewSummary {
  let count = 0;
  let sum = 0;
  for (const rating of ratings) {
    if (isValidRating(rating)) {
      count += 1;
      sum += rating;
    }
  }
  return { count, sum, averageX100: count === 0 ? 0 : Math.floor((sum * 100) / count) };
}

// ---- display helpers (never wire values) ----

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);

/** Render integer minor units without floats; defaults to two decimals (cents). */
export function formatMinor(price: number, currency: string): string {
  if (!Number.isSafeInteger(price) || price < 0) return `? ${currency}`;
  const digits = ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
  const value = BigInt(price);
  const scale = 10n ** BigInt(digits);
  const major = value / scale;
  const minor = value % scale;
  const fraction = digits === 0 ? '' : `.${minor.toString().padStart(digits, '0')}`;
  return `${major}${fraction} ${currency}`;
}

/** Parse a non-negative integer input (price in minor units, stock, qty). */
export function parseUint(input: string, max: number): number | null {
  const clean = input.trim();
  if (!/^\d+$/.test(clean)) return null;
  const value = Number(clean);
  if (!Number.isSafeInteger(value) || value > max) return null;
  return value;
}
