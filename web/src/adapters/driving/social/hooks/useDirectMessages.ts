import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchNym } from '../../../../mixnet/fetchNym';
import { isDefinitiveServiceError, pollDelayMs } from '../../../../mixnet/backoff.mjs';
import { openDm, packDmInner, sealDm, unpackDmInner } from '../../../../application/dm';
import { MAX_DM_CIPHERTEXT_BYTES } from '../../../../domain/limits';
import { JSON_HEADERS, b64decode, buildDmRequest } from '../../../../domain/api';
import {
  addDmRecord,
  defaultDmStore,
  loadDmCache,
  loadDmRead,
  markConversationRead,
  saveDmCache,
  saveDmRead,
  type DmRecord,
} from '../../../../application/conversations';
import { uploadBlobs } from '../../../driven/blobUploadIo';
import type { AttachmentRef, PreparedAttachment } from '../../../../domain/attachmentCrypto';
import type { Identity } from '../../../../domain/identity';
import type { PowFor } from './usePow';

export interface DirectMessages {
  dmTo: string;
  setDmTo: (value: string) => void;
  dmDraft: string;
  setDmDraft: (value: string) => void;
  dmFiles: PreparedAttachment[];
  setDmFiles: (files: PreparedAttachment[]) => void;
  dms: DmRecord[];
  dmRead: Record<string, number>;
  activeDmPeer: string | null;
  /** `force` clears backoff/pause; use it for the manual "Check" button. */
  pollDms: (force?: boolean) => Promise<void>;
  onSendDm: () => Promise<void>;
  openConvo: (peer: string) => void;
}

/**
 * Sealed 1:1 DMs: composer state, the destructive dead-drop poll, and the
 * local conversation cache (the cache is the history, since the provider
 * deletes each message on read).
 */
export function useDirectMessages({
  service,
  identity,
  append,
  authed,
  powFor,
  setBusy,
}: {
  service: string;
  identity: Identity | null;
  append: (line: string) => void;
  authed: <T>(fn: (id: Identity) => Promise<T>) => Promise<T | null>;
  powFor: PowFor;
  setBusy: (value: boolean) => void;
}): DirectMessages {
  const [dmTo, setDmTo] = useState('');
  const [dmDraft, setDmDraft] = useState('');
  const [dmFiles, setDmFiles] = useState<PreparedAttachment[]>([]);
  // Local DM history: the dead-drop deletes on read, so every decrypted
  // record is cached on this device and grouped into 1:1 conversations.
  const [dms, setDms] = useState<DmRecord[]>(() => loadDmCache(defaultDmStore()));
  const [dmRead, setDmRead] = useState<Record<string, number>>(() => loadDmRead(defaultDmStore()));
  const [activeDmPeer, setActiveDmPeer] = useState<string | null>(null);
  // Poll pacing state (see `mixnet/backoff.mjs`): consecutive transport
  // failures back off; a definitive service error pauses until Check again.
  const dmFailuresRef = useRef(0);
  const dmStoppedRef = useRef(false);

  // A new service means a new dead-drop: drop the cached DM history and
  // staged attachments (matches the feed reset on service switch).
  useEffect(() => {
    setDms([]);
    setDmFiles([]);
    dmFailuresRef.current = 0;
    dmStoppedRef.current = false;
  }, [service]);

  /**
   * Poll the DM dead-drop (needs an identity to open anything addressed to
   * you). Destructive read server-side: fetched messages are gone from the
   * provider, so every decrypted record is cached locally the moment it
   * arrives — the cache is the history. `force` clears backoff/pause (the
   * manual "Check for new messages" button).
   */
  const pollDms = useCallback(
    async (force = false) => {
      if (!service || !identity) return;
      if (force) {
        dmFailuresRef.current = 0;
        dmStoppedRef.current = false;
      }
      try {
        const res = await fetchNym(service, {
          method: 'GET',
          path: `/dm?for=${identity.pubHex}`,
        });
        if (res.error) {
          // Definitive client error (e.g. not a community endpoint): pause
          // the automatic poller; 429/5xx just back off.
          if (isDefinitiveServiceError(res.status)) dmStoppedRef.current = true;
          else dmFailuresRef.current += 1;
          return;
        }
        dmFailuresRef.current = 0;
        dmStoppedRef.current = false;
        const body = JSON.parse(new TextDecoder().decode(res.body)) as {
          dms: { epub: string; nonce: string; ciphertext: string }[];
        };
        const fresh: DmRecord[] = [];
        for (const dm of body.dms) {
          let plain: Uint8Array;
          try {
            plain = openDm(identity.privHex, {
              epubHex: dm.epub,
              nonceHex: dm.nonce,
              ciphertextB64: dm.ciphertext,
            });
          } catch {
            append('DM undecryptable (not for this key or corrupted)');
            continue;
          }
          const at = Date.now();
          try {
            const inner = unpackDmInner(new TextDecoder().decode(plain));
            fresh.push({
              peer: inner.from,
              incoming: true,
              text: new TextDecoder().decode(inner.body),
              at,
              ts: inner.ts,
              msgId: inner.msgId,
              attachments: inner.atts,
            });
          } catch {
            // Legacy sender (pre-envelope): no attribution possible.
            fresh.push({
              peer: 'unknown',
              incoming: true,
              text: new TextDecoder().decode(plain),
              at,
              ts: at,
              msgId: `legacy-${at}-${Math.random().toString(36).slice(2)}`,
            });
          }
        }
        if (fresh.length > 0) {
          setDms((prev) => {
            let next = prev;
            for (const r of fresh) next = addDmRecord(next, r);
            if (next !== prev) saveDmCache(next, defaultDmStore());
            return next;
          });
          append(fresh.length === 1 ? 'DM received and decrypted' : `${fresh.length} DMs received and decrypted`);
        }
      } catch (err) {
        // Transport failure: back off, keep trying.
        dmFailuresRef.current += 1;
        append(`dm poll failed: ${String(err)}`);
      }
    },
    [service, identity, append],
  );

  // Same chained, non-overlapping pattern as the feed poll, with the same
  // backoff + pause semantics so a lost portal is not polled forever.
  useEffect(() => {
    if (!service || !identity) return;
    let cancelled = false;
    let timer = 0;
    let inFlight = false;
    const tick = async () => {
      if (cancelled || dmStoppedRef.current) return;
      if (!inFlight) {
        inFlight = true;
        try {
          await pollDms();
        } finally {
          inFlight = false;
        }
      }
      if (cancelled || dmStoppedRef.current) return;
      timer = window.setTimeout(tick, pollDelayMs(dmFailuresRef.current));
    };
    timer = window.setTimeout(tick, pollDelayMs(dmFailuresRef.current));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [service, identity, pollDms]);

  const onSendDm = useCallback(async () => {
    if (!service || !dmTo || !dmDraft) return;
    const recipient = dmTo.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(recipient)) {
      append('recipient must be a 64-hex ID');
      return;
    }
    setBusy(true);
    try {
      await authed(async (id) => {
        // Attachments pack inside the sealed box: refs (with file keys)
        // stay confidential end-to-end. Blobs upload first so a failed
        // upload aborts the send — never a dangling ref.
        const refs: AttachmentRef[] = dmFiles.map(({ id: aid, name, mime, size, key }) => ({
          id: aid,
          name,
          mime,
          size,
          key,
        }));
        if (!(await uploadBlobs(service, dmFiles, powFor, append))) return;
        // Signed inside the sealed box: the recipient can attribute the
        // message, the provider cannot.
        const packed = packDmInner(id.privHex, new TextEncoder().encode(dmDraft), refs);
        const sealed = sealDm(recipient, new TextEncoder().encode(packed.json));
        const ctBytes = b64decode(sealed.ciphertextB64);
        if (ctBytes.length > MAX_DM_CIPHERTEXT_BYTES) {
          append(
            `dm too large sealed (${ctBytes.length}B > ${MAX_DM_CIPHERTEXT_BYTES}B); shorten the text or drop attachments`,
          );
          return;
        }
        const pow = await powFor(service, recipient, ctBytes);
        const req = buildDmRequest({
          to: recipient,
          epubHex: sealed.epubHex,
          nonceHex: sealed.nonceHex,
          ciphertextB64: sealed.ciphertextB64,
          pow,
        });
        const res = await fetchNym(service, {
          method: 'POST',
          ...req,
          headers: JSON_HEADERS,
        });
        if (res.error) append(`dm rejected: ${res.error}`);
        else {
          append('DM sent (sealed)');
          setDmDraft('');
          setDmFiles([]);
          const at = Date.now();
          setDms((prev) => {
            const next = addDmRecord(prev, {
              peer: recipient,
              incoming: false,
              text: dmDraft,
              at,
              ts: at,
              msgId: packed.msgId,
              attachments: refs,
            });
            saveDmCache(next, defaultDmStore());
            return next;
          });
          setActiveDmPeer(recipient);
        }
      });
    } catch (err) {
      append(`dm failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [service, dmTo, dmDraft, dmFiles, append, powFor, authed, setBusy]);

  const openConvo = useCallback((peer: string) => {
    setActiveDmPeer(peer);
    if (peer !== 'unknown') setDmTo(peer);
    setDmRead((prev) => {
      const next = markConversationRead(prev, peer);
      if (next !== prev) saveDmRead(next, defaultDmStore());
      return next;
    });
  }, []);

  return {
    dmTo,
    setDmTo,
    dmDraft,
    setDmDraft,
    dmFiles,
    setDmFiles,
    dms,
    dmRead,
    activeDmPeer,
    pollDms,
    onSendDm,
    openConvo,
  };
}
