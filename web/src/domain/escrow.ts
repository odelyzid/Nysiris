/**
 * Monero escrow wire grammar — byte-exact mirror of
 * `crates/escrow-format/src/{limits,message,state}.rs` (spec: docs/17).
 *
 * This is a stagenet reference format only. It carries signed messages and
 * opaque wallet blobs; it has no key storage, no RPC client, and no funds.
 * Keep field order and integer widths identical to Rust: domain(24) NUL-padded,
 * actor(32), day_be64, seq_be64, fixed payload fields first, u16 byte lengths,
 * u64/u32 big-endian, then a 64-byte ed25519 signature over all prior bytes.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const OPEN_DOMAIN = 'fly-escrow-v1/open';
export const JOIN_DOMAIN = 'fly-escrow-v1/join';
export const COMMIT_DOMAIN = 'fly-escrow-v1/commit';
export const FUNDED_DOMAIN = 'fly-escrow-v1/funded';
export const RELEASE_DOMAIN = 'fly-escrow-v1/release';
export const APPROVE_DOMAIN = 'fly-escrow-v1/approve';
export const DISPUTE_DOMAIN = 'fly-escrow-v1/dispute';
export const RESOLVE_DOMAIN = 'fly-escrow-v1/resolve';
export const CANCEL_DOMAIN = 'fly-escrow-v1/cancel';
export const SUBMITTED_DOMAIN = 'fly-escrow-v1/submitted';

/** Mirror of `escrow_format::limits` (checked by scripts/check-constants.mjs). */
export const MAX_ESCROW_ATOMIC = 10_000_000_000_000;
export const MAX_BLOB_BYTES = 16_384;
export const MAX_ENVELOPE_BYTES = 32_768;
export const MAX_PROOF_BYTES = 8_192;
export const MAX_ADDRESS_BYTES = 128;
export const MAX_BODY_BYTES = 256;
export const MAX_SEQ = 9_223_372_036_854_775_807;
export const DAY_SKEW = 2;
export const FUNDING_DAYS = 3;
export const XMR_ATOMIC_UNITS = 1_000_000_000_000;

const DOMAIN_LEN = 24;
const SIG_LEN = 64;
const HEADER_LEN = DOMAIN_LEN + 32 + 8 + 8;
const MAX_U16 = 0xffff;

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u16be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > MAX_U16) throw new Error('u16 out of range');
  return new Uint8Array([(n >>> 8) & 0xff, n & 0xff]);
}

function u64be(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new Error('u64 out of range');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v);
  return out;
}

function domainBytes(name: string): Uint8Array {
  const raw = encoder.encode(name);
  if (raw.length > DOMAIN_LEN) throw new Error('escrow domain too long');
  const out = new Uint8Array(DOMAIN_LEN);
  out.set(raw);
  return out;
}

function checkText(bytes: Uint8Array): void {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('field contains NUL');
}

function textBytes(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  checkText(bytes);
  return bytes;
}

function varBytes(value: Uint8Array, cap: number): Uint8Array {
  if (value.length > cap || value.length > MAX_U16) throw new Error('variable field exceeds cap');
  return concat(u16be(value.length), value);
}

function fixedBytes(hex: string, byteLen: number, label: string): Uint8Array {
  if (!new RegExp(`^[0-9a-f]{${byteLen * 2}}$`, 'i').test(hex)) {
    throw new Error(`invalid ${label} hex`);
  }
  return hexToBytes(hex);
}

function keyBytes(hex: string, label: string): Uint8Array {
  return fixedBytes(hex, 32, label);
}

function envelope(domain: string, actor: string, day: number | bigint, seq: number | bigint, payload: Uint8Array): Uint8Array {
  if (BigInt(seq) > BigInt(MAX_SEQ)) throw new Error('sequence above MAX_SEQ');
  return concat(domainBytes(domain), keyBytes(actor, 'actor'), u64be(day), u64be(seq), payload);
}

/** Build an unsigned envelope. Sign with `signEnvelope`. */
export function unsigned(
  domain: string,
  actor: string,
  day: number | bigint,
  seq: number | bigint,
  payload: Uint8Array,
): Uint8Array {
  return envelope(domain, actor, day, seq, payload);
}

export function signEnvelope(unsignedBytes: Uint8Array, privHex: string): Uint8Array {
  return concat(unsignedBytes, ed25519.sign(unsignedBytes, keyBytes(privHex, 'private key')));
}

/** Verify a signed envelope and return its parsed header plus raw payload. */
export function verifyEnvelope(signed: Uint8Array): {
  domain: (typeof DOMAINS)[number];
  actor: string;
  day: bigint;
  seq: bigint;
  payload: Uint8Array;
} {
  if (signed.length < HEADER_LEN + SIG_LEN) throw new Error('escrow envelope too short');
  const preimage = signed.subarray(0, signed.length - SIG_LEN);
  const sig = signed.subarray(signed.length - SIG_LEN);
  const actor = preimage.subarray(DOMAIN_LEN, DOMAIN_LEN + 32);
  if (!ed25519.verify(sig, preimage, actor)) throw new Error('escrow signature does not verify');
  const domainRaw = bytesToHex(preimage.subarray(0, DOMAIN_LEN));
  const domain = DOMAINS.find((d) => bytesToHex(domainBytes(d)) === domainRaw);
  if (!domain) throw new Error('unknown escrow domain');
  const view = new DataView(preimage.buffer, preimage.byteOffset, preimage.byteLength);
  const day = view.getBigUint64(DOMAIN_LEN + 32);
  const seq = view.getBigUint64(DOMAIN_LEN + 40);
  if (seq > BigInt(MAX_SEQ)) throw new Error('sequence above MAX_SEQ');
  // Keep u64 fields as bigint: Number(day) silently loses precision above 2^53.
  return {
    domain,
    actor: bytesToHex(actor),
    day,
    seq,
    payload: preimage.subarray(HEADER_LEN),
  };
}

export const DOMAINS = [
  OPEN_DOMAIN,
  JOIN_DOMAIN,
  COMMIT_DOMAIN,
  FUNDED_DOMAIN,
  RELEASE_DOMAIN,
  APPROVE_DOMAIN,
  DISPUTE_DOMAIN,
  RESOLVE_DOMAIN,
  CANCEL_DOMAIN,
  SUBMITTED_DOMAIN,
] as const;

function common(orderHex: string, nonceHex: string): Uint8Array {
  return concat(fixedBytes(orderHex, 16, 'order id'), fixedBytes(nonceHex, 16, 'nonce'));
}

function currencyBytes(code: string): Uint8Array {
  if (!/^[A-Z]{3}$/.test(code)) throw new Error('currency must be 3 uppercase ASCII letters');
  return encoder.encode(code);
}

function roleByte(role: number): Uint8Array {
  if (!Number.isInteger(role) || role < 0 || role > 2) throw new Error('unknown escrow role');
  return new Uint8Array([role]);
}

export function openUnsigned(
  actor: string, day: number | bigint, seq: number | bigint,
  order: string, nonce: string, seller: string, arbiter: string,
  amount: number | bigint, currency: string,
): Uint8Array {
  if (BigInt(amount) <= 0n || BigInt(amount) > BigInt(MAX_ESCROW_ATOMIC)) {
    throw new Error('amount outside the reference cap');
  }
  return envelope(OPEN_DOMAIN, actor, day, seq, concat(
    common(order, nonce),
    keyBytes(seller, 'seller'),
    keyBytes(arbiter, 'arbiter'),
    u64be(amount),
    currencyBytes(currency),
  ));
}

export function joinUnsigned(
  actor: string, day: number | bigint, seq: number | bigint,
  order: string, nonce: string, role: number, blob: Uint8Array,
): Uint8Array {
  if (blob.length === 0) throw new Error('empty multisig setup blob');
  return envelope(JOIN_DOMAIN, actor, day, seq, concat(
    common(order, nonce), roleByte(role), varBytes(blob, MAX_BLOB_BYTES),
  ));
}

export function commitUnsigned(
  actor: string, day: number | bigint, seq: number | bigint,
  order: string, nonce: string, round: number, address: string, transcriptHash: string,
): Uint8Array {
  if (round < 1 || round > 3) throw new Error('unknown multisig setup round');
  const addr = textBytes(address);
  return envelope(COMMIT_DOMAIN, actor, day, seq, concat(
    common(order, nonce),
    new Uint8Array([round]),
    varBytes(addr, MAX_ADDRESS_BYTES),
    keyBytes(transcriptHash, 'transcript hash'),
  ));
}

export function fundedUnsigned(
  actor: string, day: number | bigint, seq: number | bigint,
  order: string, nonce: string, txid: string, amount: number | bigint, proof: Uint8Array,
): Uint8Array {
  if (proof.length === 0) throw new Error('empty transaction proof');
  return envelope(FUNDED_DOMAIN, actor, day, seq, concat(
    common(order, nonce), keyBytes(txid, 'txid'), u64be(amount), varBytes(proof, MAX_PROOF_BYTES),
  ));
}

export function releaseUnsigned(
  actor: string, day: number | bigint, seq: number | bigint,
  order: string, nonce: string, payout: string, amount: number | bigint,
  inputsHash: string, txsetHash: string,
): Uint8Array {
  const addr = textBytes(payout);
  if (addr.length === 0) throw new Error('empty payout address');
  return envelope(RELEASE_DOMAIN, actor, day, seq, concat(
    common(order, nonce),
    varBytes(addr, MAX_ADDRESS_BYTES),
    u64be(amount),
    keyBytes(inputsHash, 'inputs hash'),
    keyBytes(txsetHash, 'txset hash'),
  ));
}

export function approveUnsigned(
  actor: string, day: number | bigint, seq: number | bigint,
  order: string, nonce: string, releaseDigest: string, role: number,
): Uint8Array {
  return envelope(APPROVE_DOMAIN, actor, day, seq, concat(
    common(order, nonce), keyBytes(releaseDigest, 'release digest'), roleByte(role),
  ));
}

export function disputeUnsigned(
  actor: string, day: number | bigint, seq: number | bigint,
  order: string, nonce: string, reason: number, body: string,
): Uint8Array {
  return envelope(DISPUTE_DOMAIN, actor, day, seq, concat(
    common(order, nonce), new Uint8Array([reason]), varBytes(textBytes(body), MAX_BODY_BYTES),
  ));
}

export function resolveUnsigned(
  actor: string, day: number | bigint, seq: number | bigint,
  order: string, nonce: string, disputeDigest: string, decision: number,
  payout: string, inputsHash: string,
): Uint8Array {
  if (decision !== 0 && decision !== 1) throw new Error('unknown dispute decision');
  const addr = textBytes(payout);
  if (addr.length === 0) throw new Error('empty payout address');
  return envelope(RESOLVE_DOMAIN, actor, day, seq, concat(
    common(order, nonce),
    keyBytes(disputeDigest, 'dispute digest'),
    new Uint8Array([decision]),
    varBytes(addr, MAX_ADDRESS_BYTES),
    keyBytes(inputsHash, 'inputs hash'),
  ));
}

export function cancelUnsigned(
  actor: string, day: number | bigint, seq: number | bigint,
  order: string, nonce: string, reason: number,
): Uint8Array {
  return envelope(CANCEL_DOMAIN, actor, day, seq, concat(
    common(order, nonce), new Uint8Array([reason]),
  ));
}

export function submittedUnsigned(
  actor: string, day: number | bigint, seq: number | bigint,
  order: string, nonce: string, txid: string, kind: number,
): Uint8Array {
  if (kind !== 0 && kind !== 1) throw new Error('unknown submitted kind');
  return envelope(SUBMITTED_DOMAIN, actor, day, seq, concat(
    common(order, nonce), keyBytes(txid, 'txid'), new Uint8Array([kind]),
  ));
}

/** SHA-256 over a complete signed envelope, used for digest bindings. */
export function envelopeDigest(signed: Uint8Array): string {
  return bytesToHex(sha256(signed));
}

/** Coarse UTC day, same convention as the shop protocol. */
export function currentDay(nowMs = Date.now()): number {
  return Math.floor(nowMs / 86_400_000);
}

/**
 * Message signed by the funding wallet (doc 17 §17.7). It binds the frozen
 * amount so a proof for a smaller payment cannot be replayed as full funding.
 */
export function fundingProofMessage(order: string, nonce: string, amount: number | bigint): string {
  fixedBytes(order, 16, 'order id');
  fixedBytes(nonce, 16, 'nonce');
  return `nysiris-escrow:${order.toLowerCase()}:${nonce.toLowerCase()}:funded:${amount}`;
}

/** SHA-256(order bytes || nonce bytes || address bytes), same as escrow-format and the harness. */
export function setupTranscriptHash(order: string, nonce: string, address: string): string {
  return bytesToHex(sha256(concat(
    fixedBytes(order, 16, 'order id'),
    fixedBytes(nonce, 16, 'nonce'),
    textBytes(address),
  )));
}

/**
 * Match the harness's `json.dumps(sort_keys=True, separators=(',', ':'),
 * ensure_ascii=False)`: recursively sort object keys and emit no whitespace.
 * Monero RPC field names and addresses are ASCII, so JS's default string sort
 * agrees with Python's code-point sort for this message shape.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
}

/** Hash the full canonical `describe_transfer.desc` list before signing/submission. */
export function txsetDescriptionHash(desc: unknown): string {
  return bytesToHex(sha256(encoder.encode(canonicalJson(desc))));
}

// ---------------------------------------------------------------------------
// Independent verification mirror (doc 17 §17.7.1). A client must never trust
// the relay's convenience `stage`: decode and replay every signed envelope.
// This module still has no wallet, RPC client, key storage, or funds; proof
// checking and dispute evidence stay in the external wallet / E2E DMs.
// ---------------------------------------------------------------------------

export type DecodedEnvelope =
  | { domain: typeof OPEN_DOMAIN; order: string; nonce: string; seller: string; arbiter: string; amount: bigint; currency: string }
  | { domain: typeof JOIN_DOMAIN; order: string; nonce: string; role: number; blob: Uint8Array }
  | { domain: typeof COMMIT_DOMAIN; order: string; nonce: string; round: number; address: string; transcriptHash: string }
  | { domain: typeof FUNDED_DOMAIN; order: string; nonce: string; txid: string; amount: bigint; proof: Uint8Array }
  | { domain: typeof RELEASE_DOMAIN; order: string; nonce: string; payout: string; amount: bigint; inputsHash: string; txsetHash: string }
  | { domain: typeof APPROVE_DOMAIN; order: string; nonce: string; releaseDigest: string; role: number }
  | { domain: typeof DISPUTE_DOMAIN; order: string; nonce: string; reason: number; body: string }
  | { domain: typeof RESOLVE_DOMAIN; order: string; nonce: string; disputeDigest: string; decision: number; payout: string; inputsHash: string }
  | { domain: typeof CANCEL_DOMAIN; order: string; nonce: string; reason: number }
  | { domain: typeof SUBMITTED_DOMAIN; order: string; nonce: string; txid: string; kind: number };

class Reader {
  private at = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  take(len: number): Uint8Array {
    const end = this.at + len;
    if (len < 0 || end > this.bytes.length) throw new Error('truncated escrow message');
    const out = this.bytes.slice(this.at, end);
    this.at = end;
    return out;
  }

  fixed(len: number, label: string): string {
    return bytesToHex(this.take(len));
  }

  u8(): number {
    return this.take(1)[0];
  }

  u64(): bigint {
    const raw = this.take(8);
    return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigUint64(0);
  }

  variable(cap: number, label: string): Uint8Array {
    const len = this.u16();
    if (len > cap) throw new Error(`variable field of ${len} bytes exceeds cap ${cap}`);
    return this.take(len);
  }

  text(cap: number, label: string): string {
    const raw = this.variable(cap, label);
    checkText(raw);
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  }

  done(): void {
    if (this.at !== this.bytes.length) throw new Error('trailing bytes in escrow payload');
  }

  private u16(): number {
    const raw = this.take(2);
    return (raw[0] << 8) | raw[1];
  }
}

function parseRole(value: number): number {
  if (value > 2) throw new Error('unknown escrow role');
  return value;
}

/** Decode a verified envelope's payload. Trailing or oversized fields fail closed. */
export function decodeEnvelope(signed: Uint8Array): DecodedEnvelope & { actor: string; day: bigint; seq: bigint } {
  if (signed.length > MAX_ENVELOPE_BYTES) throw new Error('escrow envelope exceeds relay cap');
  const env = verifyEnvelope(signed);
  const r = new Reader(env.payload);
  const order = r.fixed(16, 'order id');
  const nonce = r.fixed(16, 'nonce');
  let decoded: DecodedEnvelope;
  switch (env.domain) {
    case OPEN_DOMAIN: {
      const seller = r.fixed(32, 'seller');
      const arbiter = r.fixed(32, 'arbiter');
      const amount = r.u64();
      const currency = new TextDecoder().decode(r.take(3));
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be 3 uppercase ASCII letters');
      decoded = { domain: env.domain, order, nonce, seller, arbiter, amount, currency };
      break;
    }
    case JOIN_DOMAIN:
      decoded = { domain: env.domain, order, nonce, role: parseRole(r.u8()), blob: r.variable(MAX_BLOB_BYTES, 'blob') };
      break;
    case COMMIT_DOMAIN: {
      const round = r.u8();
      if (round < 1 || round > 3) throw new Error('unknown multisig setup round');
      decoded = {
        domain: env.domain, order, nonce, round,
        address: r.text(MAX_ADDRESS_BYTES, 'address'),
        transcriptHash: r.fixed(32, 'transcript hash'),
      };
      break;
    }
    case FUNDED_DOMAIN: {
      const txid = r.fixed(32, 'txid');
      const amount = r.u64();
      const proof = r.variable(MAX_PROOF_BYTES, 'proof');
      if (proof.length === 0) throw new Error('empty transaction proof');
      decoded = { domain: env.domain, order, nonce, txid, amount, proof };
      break;
    }
    case RELEASE_DOMAIN: {
      const payout = r.text(MAX_ADDRESS_BYTES, 'payout');
      if (payout.length === 0) throw new Error('empty payout address');
      decoded = {
        domain: env.domain, order, nonce, payout, amount: r.u64(),
        inputsHash: r.fixed(32, 'inputs hash'), txsetHash: r.fixed(32, 'txset hash'),
      };
      break;
    }
    case APPROVE_DOMAIN:
      decoded = {
        domain: env.domain, order, nonce,
        releaseDigest: r.fixed(32, 'release digest'), role: parseRole(r.u8()),
      };
      break;
    case DISPUTE_DOMAIN:
      decoded = { domain: env.domain, order, nonce, reason: r.u8(), body: r.text(MAX_BODY_BYTES, 'body') };
      break;
    case RESOLVE_DOMAIN: {
      const disputeDigest = r.fixed(32, 'dispute digest');
      const decision = r.u8();
      if (decision > 1) throw new Error('unknown dispute decision');
      const payout = r.text(MAX_ADDRESS_BYTES, 'payout');
      if (payout.length === 0) throw new Error('empty payout address');
      decoded = { domain: env.domain, order, nonce, disputeDigest, decision, payout, inputsHash: r.fixed(32, 'inputs hash') };
      break;
    }
    case CANCEL_DOMAIN:
      decoded = { domain: env.domain, order, nonce, reason: r.u8() };
      break;
    case SUBMITTED_DOMAIN: {
      const txid = r.fixed(32, 'txid');
      const kind = r.u8();
      if (kind > 1) throw new Error('unknown submitted kind');
      decoded = { domain: env.domain, order, nonce, txid, kind };
      break;
    }
    default:
      throw new Error('unknown escrow domain');
  }
  r.done();
  return { ...decoded, actor: env.actor, day: env.day, seq: env.seq };
}

const ZERO16 = '00'.repeat(16);
const ZERO32 = '00'.repeat(32);
export type Stage =
  | 'proposed' | 'joined' | 'setup' | 'awaiting_spend'
  | 'releasing' | 'disputed' | 'resolved' | 'released' | 'cancelled';

/**
 * Browser replay of `crates/escrow-format/src/state.rs`. Every rejection
 * happens before mutation, so a rejected envelope leaves this mirror exactly
 * as it was. No local clock is consulted by `applyReplay`.
 */
export class EscrowMirror {
  stage: Stage = 'proposed';
  order = '00'.repeat(16);
  nonce = '00'.repeat(16);
  buyer = ZERO32;
  seller = ZERO32;
  arbiter = ZERO32;
  amount = 0n;
  openDay = 0n;

  private opened = false;
  private joins = new Set<number>();
  private commits: Array<{ actor: string; hash: string; address: string }> = [];
  private lastSeq = new Map<string, bigint>();
  private release: { digest: string; txsetHash: string; resolved: boolean } | null = null;
  private approvals = new Set<string>();
  private inputsSeen = new Set<string>();
  private dispute: string | null = null;
  private decision: number | null = null;
  private winner: string | null = null;
  private resolvedInputs: string | null = null;
  private resolvedPayout: string | null = null;

  get releaseTxsetHash(): string | null {
    return this.release?.txsetHash ?? null;
  }

  /** Pure client hint; never changes `stage` (only a signed `cancel` can). */
  fundingExpired(nowDay: number | bigint): boolean {
    const day = BigInt(nowDay);
    return this.opened
      && ['proposed', 'joined', 'setup'].includes(this.stage)
      && day >= this.openDay + BigInt(FUNDING_DAYS);
  }

  apply(signed: Uint8Array, nowDay: number | bigint): void {
    this.applyInner(signed, BigInt(nowDay));
  }

  applyReplay(signed: Uint8Array): void {
    this.applyInner(signed, undefined);
  }

  replayAll(signeds: Iterable<Uint8Array>): void {
    for (const signed of signeds) this.applyReplay(signed);
  }

  private roleOf(actor: string): number | undefined {
    if (actor === this.buyer) return 0;
    if (actor === this.seller) return 1;
    if (actor === this.arbiter) return 2;
    return undefined;
  }

  private common(order: string, nonce: string): void {
    if (order !== this.order || nonce !== this.nonce) {
      throw new Error('message belongs to a different escrow session');
    }
  }

  private applyInner(signed: Uint8Array, nowDay: bigint | undefined): void {
    if (this.stage === 'released' || this.stage === 'cancelled') {
      throw new Error('escrow session is closed');
    }
    const env = decodeEnvelope(signed);
    if (nowDay !== undefined && (env.day > nowDay ? env.day - nowDay : nowDay - env.day) > BigInt(DAY_SKEW)) {
      throw new Error('day outside the freshness window');
    }
    const previous = this.lastSeq.get(env.actor);
    if (previous !== undefined) {
      if (env.seq <= previous) throw new Error('replayed sequence');
    } else if (env.seq !== 0n) {
      throw new Error('first message from an actor must use seq 0');
    }
    this.dispatch(env, signed);
    this.lastSeq.set(env.actor, env.seq);
  }

  private dispatch(env: DecodedEnvelope & { actor: string; day: bigint; seq: bigint }, signed: Uint8Array): void {
    switch (env.domain) {
      case OPEN_DOMAIN: {
        if (env.order === ZERO16 || env.nonce === ZERO16) throw new Error('zero order id or nonce');
        if (env.amount <= 0n || env.amount > BigInt(MAX_ESCROW_ATOMIC)) throw new Error('amount outside the reference cap');
        if (env.currency !== 'XMR') throw new Error('escrow requires XMR currency');
        if (this.opened) throw new Error('escrow already opened');
        if (this.stage !== 'proposed') throw new Error('open in wrong stage');
        if (env.actor === env.seller || env.actor === env.arbiter || env.seller === env.arbiter) {
          throw new Error('buyer, seller, and arbiter must be distinct');
        }
        this.order = env.order;
        this.nonce = env.nonce;
        this.buyer = env.actor;
        this.seller = env.seller;
        this.arbiter = env.arbiter;
        this.amount = env.amount;
        this.openDay = env.day;
        this.opened = true;
        return;
      }
      case JOIN_DOMAIN: {
        if (!this.opened || this.stage !== 'proposed') throw new Error('join requires an open, unjoined session');
        this.common(env.order, env.nonce);
        if (env.blob.length === 0) throw new Error('empty multisig setup blob');
        if (this.roleOf(env.actor) !== env.role) throw new Error('role does not match the signing key');
        if (this.joins.has(env.role)) throw new Error('duplicate join for this role');
        this.joins.add(env.role);
        if (this.joins.size === 3) this.stage = 'joined';
        return;
      }
      case COMMIT_DOMAIN: {
        if (this.stage !== 'joined') throw new Error('commit requires all three joins');
        if (env.round !== 3) throw new Error('signed commit must be the final setup round');
        this.common(env.order, env.nonce);
        if (this.roleOf(env.actor) === undefined) throw new Error('commit from an unknown participant');
        if (this.commits.some((c) => c.actor === env.actor)) throw new Error('duplicate commit');
        if (env.transcriptHash !== setupTranscriptHash(env.order, env.nonce, env.address)) {
          throw new Error('commit transcript hash does not match the derived session');
        }
        const pending = [...this.commits, { actor: env.actor, hash: env.transcriptHash, address: env.address }];
        if (pending.length === 3) {
          const first = pending[0];
          if (pending.some((c) => c.hash !== first.hash || c.address !== first.address)) {
            throw new Error('participants disagree on the escrow address; restart with a new nonce');
          }
          this.stage = 'setup';
        }
        this.commits = pending;
        return;
      }
      case FUNDED_DOMAIN: {
        if (this.stage !== 'setup') throw new Error('funding proof in wrong stage');
        this.common(env.order, env.nonce);
        if (env.actor !== this.buyer) throw new Error('only the buyer can post funding');
        if (env.txid === ZERO32) throw new Error('zero funding txid');
        if (env.amount !== this.amount) throw new Error('funding amount does not match the frozen terms');
        this.stage = 'awaiting_spend';
        return;
      }
      case RELEASE_DOMAIN: {
        if (this.stage !== 'awaiting_spend' && this.stage !== 'resolved') throw new Error('release proposal in wrong stage');
        this.common(env.order, env.nonce);
        const resolved = this.stage === 'resolved';
        const expected = resolved ? this.winner : this.seller;
        if (env.actor !== expected) throw new Error('release must come from the seller or the dispute winner');
        if (env.amount !== this.amount) throw new Error('release amount does not match the frozen terms');
        if (env.inputsHash === ZERO32 || env.txsetHash === ZERO32) {
          throw new Error('release must bind non-zero inputs and txset hashes');
        }
        if (resolved) {
          if (this.resolvedInputs !== env.inputsHash || this.resolvedPayout !== env.payout) {
            throw new Error('resolved release must bind the arbiter\'s decision');
          }
        } else {
          if (this.inputsSeen.has(env.inputsHash)) throw new Error('inputs already used in this session');
          this.inputsSeen.add(env.inputsHash);
        }
        this.release = { digest: envelopeDigest(signed), txsetHash: env.txsetHash, resolved };
        this.stage = 'releasing';
        return;
      }
      case APPROVE_DOMAIN: {
        if (this.stage !== 'releasing') throw new Error('approval in wrong stage');
        this.common(env.order, env.nonce);
        if (this.roleOf(env.actor) === undefined || env.actor === this.seller) {
          throw new Error('approval must come from buyer or arbiter');
        }
        if (this.roleOf(env.actor) !== env.role) throw new Error('approval role does not match the signing key');
        const rel = this.release;
        if (!rel) throw new Error('no release to approve');
        if (rel.digest !== env.releaseDigest) throw new Error('approval binds a different release');
        if (rel.resolved) {
          if (env.actor !== this.arbiter) throw new Error('a resolved payout is approved only by the arbiter');
        } else if (env.actor !== this.buyer) {
          throw new Error('a normal payout is approved only by the buyer');
        }
        if (this.approvals.has(env.actor)) throw new Error('duplicate approval');
        this.approvals.add(env.actor);
        return;
      }
      case DISPUTE_DOMAIN: {
        if (this.stage !== 'awaiting_spend') throw new Error('dispute in wrong stage');
        this.common(env.order, env.nonce);
        if (env.actor !== this.buyer && env.actor !== this.seller) throw new Error('dispute must come from buyer or seller');
        this.dispute = envelopeDigest(signed);
        this.stage = 'disputed';
        return;
      }
      case RESOLVE_DOMAIN: {
        if (this.stage !== 'disputed') throw new Error('resolution in wrong stage');
        this.common(env.order, env.nonce);
        if (env.actor !== this.arbiter) throw new Error('only the arbiter can resolve');
        if (this.dispute !== env.disputeDigest) throw new Error('resolution binds a different dispute');
        this.resolvedInputs = env.inputsHash;
        this.resolvedPayout = env.payout;
        this.decision = env.decision;
        this.winner = env.decision === 0 ? this.seller : this.buyer;
        this.stage = 'resolved';
        return;
      }
      case SUBMITTED_DOMAIN: {
        if (this.stage !== 'releasing') throw new Error('submission in wrong stage');
        this.common(env.order, env.nonce);
        if (this.roleOf(env.actor) === undefined) throw new Error('submission from an unknown participant');
        const rel = this.release;
        if (!rel) throw new Error('no release to submit');
        if (rel.resolved) {
          if (!this.approvals.has(this.arbiter)) throw new Error('a resolved payout needs the arbiter\'s signature');
        } else if (this.approvals.size === 0) {
          throw new Error('submission needs two signatures');
        }
        if (env.txid === ZERO32) throw new Error('zero submission txid');
        const expectedKind = rel.resolved ? (this.decision === 1 ? 1 : 0) : 0;
        if (env.kind !== expectedKind) throw new Error('submission kind does not match the payout');
        this.stage = 'released';
        return;
      }
      case CANCEL_DOMAIN: {
        if (!['proposed', 'joined', 'setup'].includes(this.stage)) throw new Error('cancel only before funding');
        this.common(env.order, env.nonce);
        if (env.actor !== this.buyer) throw new Error('only the buyer can cancel');
        this.stage = 'cancelled';
        return;
      }
    }
  }
}

/** Replay a shop relay response and reject a provider that reports a false stage. */
export function replayRelayResponse(response: {
  session?: { stage?: string };
  events?: Array<{ envelope?: string }>;
}): EscrowMirror {
  if (!Array.isArray(response.events)) throw new Error('relay response has no event log');
  const mirror = new EscrowMirror();
  for (const event of response.events) {
    if (typeof event?.envelope !== 'string') throw new Error('relay event has no signed envelope');
    mirror.applyReplay(hexToBytes(event.envelope));
  }
  if (response.session?.stage && response.session.stage !== mirror.stage) {
    throw new Error('relay stage does not match the replayed signed log');
  }
  return mirror;
}
