import { useCallback, useEffect, useState } from 'react';
import { fetchNym } from '../../../../mixnet/fetchNym';
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
  pollDms: () => Promise<void>;
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

  // A new service means a new dead-drop: drop the cached DM history and
  // staged attachments (matches the feed reset on service switch).
  useEffect(() => {
    setDms([]);
    setDmFiles([]);
  }, [service]);

  // Poll the DM dead-drop (needs an identity to open anything addressed to
  // you). Destructive read server-side: fetched messages are gone from the
  // provider, so every decrypted record is cached locally the moment it
  // arrives — the cache is the history.
  const pollDms = useCallback(async () => {
    if (!service || !identity) return;
    try {
      const res = await fetchNym(service, {
        method: 'GET',
        path: `/dm?for=${identity.pubHex}`,
      });
      if (res.error) return;
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
      append(`dm poll failed: ${String(err)}`);
    }
  }, [service, identity, append]);

  // Same chained, non-overlapping pattern as the feed poll.
  useEffect(() => {
    if (!service || !identity) return;
    let cancelled = false;
    let timer = 0;
    let inFlight = false;
    const tick = async () => {
      if (cancelled) return;
      if (!inFlight) {
        inFlight = true;
        try {
          await pollDms();
        } finally {
          inFlight = false;
        }
      }
      if (!cancelled) timer = window.setTimeout(tick, 30_000);
    };
    timer = window.setTimeout(tick, 30_000);
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
