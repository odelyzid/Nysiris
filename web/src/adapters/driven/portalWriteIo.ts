/**
 * Publish signed portal objects/log entries to a provider.
 *
 * Order matters: the object must exist before the log entry references it. PoW
 * is optional and read from `GET /` (`pow_bits`); the proof binds the object id
 * for `/obj` and the SHA-256 of the entry bytes for `/log-entry`, matching
 * `services/portal-provider`.
 */
import { hexToBytes } from '@noble/hashes/utils.js';
import type { Identity } from '../../domain/identity.ts';
import {
  buildPortalPublish,
  logEntryRequestJson,
  objectRequestJson,
  type PortalPublishBundle,
} from '../../domain/portalWrite.ts';
import type { PortalContent } from '../../domain/portalContent.ts';
import { portalEntryBytes, type PortalReplica } from '../../domain/portalSync.ts';
import { payloadHashBytes, provePow } from '../../mixnet/pow.mjs';
import { fetchNym, type FetchNymResponse } from '../../mixnet/fetchNym';

export interface PortalDescriptor {
  service: string;
  version: string;
  powBits: number;
}

export interface PortalPublishOptions {
  fetch?: typeof fetchNym;
  timeoutMs?: number;
  /** Skip the descriptor GET when the caller already knows the difficulty. */
  powBits?: number;
  maxPowAttempts?: number;
}

export interface PortalPublishResult {
  bundle: PortalPublishBundle;
  objectStored: boolean;
  seq: number;
}

/** `GET /` descriptor; unknown fields are ignored, pow_bits is capped at 32. */
export async function fetchPortalDescriptor(
  address: string,
  options: PortalPublishOptions = {},
): Promise<PortalDescriptor> {
  const fetch = options.fetch ?? fetchNym;
  const res = await fetch(
    address,
    { method: 'GET', path: '/', headers: { accept: 'application/json' } },
    { timeoutMs: options.timeoutMs ?? 30_000 },
  );
  const root = responseJson(res, 'portal descriptor') as {
    service?: unknown;
    version?: unknown;
    pow_bits?: unknown;
  };
  return {
    service: typeof root.service === 'string' ? root.service : 'portal',
    version: typeof root.version === 'string' ? root.version : '0',
    powBits:
      typeof root.pow_bits === 'number' && Number.isInteger(root.pow_bits)
        ? Math.max(0, Math.min(32, root.pow_bits))
        : 0,
  };
}

export async function publishPortalContent(
  address: string,
  identity: Identity,
  kind: string,
  content: PortalContent,
  replica: PortalReplica,
  options: PortalPublishOptions = {},
): Promise<PortalPublishResult> {
  const fetch = options.fetch ?? fetchNym;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const powBits = options.powBits ?? (await fetchPortalDescriptor(address, { ...options, fetch, timeoutMs })).powBits;
  const bundle = await buildPortalPublish(identity, kind, content, replica);
  const authorBytes = hexToBytes(identity.pubHex);

  const objectPow = await proofFor(authorBytes, hexToBytes(bundle.object.id), powBits, options.maxPowAttempts);
  const objectBody = JSON.stringify(objectRequestJson(bundle, objectPow));
  const stored = await fetch(
    address,
    {
      method: 'POST',
      path: '/obj',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: new TextEncoder().encode(objectBody),
    },
    { timeoutMs },
  );
  const storedJson = responseJson(stored, 'store object') as { stored?: unknown };
  if (stored.error || stored.status !== 200) {
    throw new Error(`provider rejected object: ${stored.error ?? `HTTP ${stored.status}`}`);
  }

  const entryHash = await payloadHashBytes(portalEntryBytes(identity.pubHex, bundle.entry.seq, bundle.entry.objId));
  const entryPow = await proofFor(authorBytes, entryHash, powBits, options.maxPowAttempts);
  const entryBody = JSON.stringify(logEntryRequestJson(bundle, entryPow));
  const appended = await fetch(
    address,
    {
      method: 'POST',
      path: '/log-entry',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: new TextEncoder().encode(entryBody),
    },
    { timeoutMs },
  );
  if (appended.error || appended.status !== 200) {
    throw new Error(`provider rejected log entry: ${appended.error ?? `HTTP ${appended.status}`}`);
  }

  return {
    bundle,
    objectStored: storedJson.stored !== false,
    seq: bundle.entry.seq,
  };
}

async function proofFor(
  authorBytes: Uint8Array,
  payloadHash: Uint8Array,
  bits: number,
  maxAttempts?: number,
): Promise<{ nonce: number; bits: number } | null> {
  if (bits <= 0) return null;
  const proof = await provePow(authorBytes, payloadHash, bits, {
    maxAttempts: maxAttempts ?? 5_000_000,
  });
  if (!proof) throw new Error(`could not find a ${bits}-bit proof of work`);
  return proof;
}

function responseJson(res: FetchNymResponse, what: string): unknown {
  if (res.error) throw new Error(`${what}: ${res.error}`);
  if (res.status !== 200) throw new Error(`${what}: HTTP ${res.status}`);
  try {
    return JSON.parse(new TextDecoder().decode(res.body));
  } catch {
    throw new Error(`${what}: invalid JSON body`);
  }
}
