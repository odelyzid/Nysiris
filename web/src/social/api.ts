/**
 * Wire payloads for the nysiris-social provider. Every POST the browser sends
 * is built here so the exact JSON the service's `serde_json` decodes lives in
 * one tested place. Pure — returns `{ path, body }` shapes the tunnel driver
 * fills in; no browser globals, no mixnet imports.
 */
import { b64decode } from '../lib/bytes.ts';
import type { AttachmentRef } from './attachmentCrypto';

export interface SocialRequest {
  path: string;
  body: Uint8Array;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/**
 * `POST /post` body: author, day, text, optional parent + attachment refs,
 * signature, and (when the provider demands it) a PoW proof.
 */
export function buildPostRequest(input: {
  author: string;
  day: number;
  body: string;
  parent: string | null;
  refs: AttachmentRef[];
  sig: string;
  pow?: unknown;
}): SocialRequest {
  return {
    path: '/post',
    body: new TextEncoder().encode(
      JSON.stringify({
        author: input.author,
        day: input.day,
        body: input.body,
        ...(input.parent ? { in_reply_to: input.parent } : {}),
        ...(input.refs.length > 0 ? { attachments: input.refs } : {}),
        sig: input.sig,
        ...(input.pow ? { pow: input.pow } : {}),
      }),
    ),
  };
}

/** `POST /profile` body: author, display name, bio, day, signature, PoW. */
export function buildProfileRequest(input: {
  author: string;
  name: string;
  bio: string;
  day: number;
  sig: string;
  pow?: unknown;
}): SocialRequest {
  return {
    path: '/profile',
    body: new TextEncoder().encode(
      JSON.stringify({
        author: input.author,
        name: input.name,
        bio: input.bio,
        day: input.day,
        sig: input.sig,
        ...(input.pow ? { pow: input.pow } : {}),
      }),
    ),
  };
}

/**
 * `POST /dm` body: recipient, the sealed-box parts, and (when required) PoW.
 * `recipient` must already be a normalized 64-hex author id.
 */
export function buildDmRequest(input: {
  to: string;
  epubHex: string;
  nonceHex: string;
  ciphertextB64: string;
  pow?: unknown;
}): SocialRequest {
  return {
    path: '/dm',
    body: new TextEncoder().encode(
      JSON.stringify({
        to: input.to,
        epub: input.epubHex,
        nonce: input.nonceHex,
        ciphertext: input.ciphertextB64,
        ...(input.pow ? { pow: input.pow } : {}),
      }),
    ),
  };
}

export { b64decode };
export { JSON_HEADERS };
