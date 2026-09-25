import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { fetchNym } from '../../../../mixnet/fetchNym';
import { MAX_POST_BYTES } from '../../../../domain/limits';
import { JSON_HEADERS, buildPostRequest } from '../../../../domain/api';
import { currentDay, postPowPayload, signPost } from '../../../../application/identityStore';
import { normalizeParent } from '../../../../domain/threads';
import type { SocialTab } from '../../../../application/tabs';
import { uploadBlobs } from '../../../driven/blobUploadIo';
import type { AttachmentRef, PreparedAttachment } from '../../../../domain/attachmentCrypto';
import type { Post } from '../model';
import type { Authed } from './useIdentitySession';
import type { PowFor } from './usePow';

export interface PostComposer {
  draft: string;
  setDraft: (value: string) => void;
  postFiles: PreparedAttachment[];
  setPostFiles: (files: PreparedAttachment[]) => void;
  replyTo: Post | null;
  startReply: (post: Post) => void;
  cancelReply: () => void;
  composerRef: RefObject<HTMLInputElement>;
  onPost: () => Promise<void>;
}

/**
 * Timeline composer: draft + staged attachments + reply target, and the
 * signed send (blobs upload first so a failed upload never leaves a dangling
 * attachment ref).
 */
export function usePostComposer({
  service,
  append,
  authed,
  powFor,
  refreshFeed,
  onSelectTab,
  busy,
  setBusy,
}: {
  service: string;
  append: (line: string) => void;
  authed: Authed;
  powFor: PowFor;
  refreshFeed: () => Promise<void>;
  onSelectTab: (next: SocialTab) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
}): PostComposer {
  const [draft, setDraft] = useState('');
  const [postFiles, setPostFiles] = useState<PreparedAttachment[]>([]);
  const [replyTo, setReplyTo] = useState<Post | null>(null);
  const composerRef = useRef<HTMLInputElement | null>(null);

  // A new service means a new timeline: drop the draft target and staged
  // attachments (matches the feed reset on service switch).
  useEffect(() => {
    setPostFiles([]);
    setReplyTo(null);
  }, [service]);

  /** Start a reply: attach the parent and focus the composer. */
  const startReply = useCallback(
    (post: Post) => {
      setReplyTo(post);
      onSelectTab('timeline');
      // Focus after the tab switch paints.
      window.setTimeout(() => composerRef.current?.focus(), 0);
    },
    [onSelectTab],
  );

  const cancelReply = useCallback(() => setReplyTo(null), []);

  const onPost = useCallback(async () => {
    if (!service || !draft.trim()) return;
    setBusy(true);
    try {
      await authed(async (id) => {
        const body = new TextEncoder().encode(draft.trim().slice(0, MAX_POST_BYTES));
        const day = currentDay();
        // Replying keeps the parent's id stable for the whole send: capture
        // it up front so a thread switch mid-send can't retarget the post.
        const parent = replyTo ? normalizeParent(replyTo.id) : null;
        // Blobs upload first (chunked, content-addressed): the post only
        // carries refs, so a failed upload aborts the send — never a
        // dangling attachment.
        const refs: AttachmentRef[] = postFiles.map(({ id, name, mime, size, key }) => ({ id, name, mime, size, key }));
        if (!(await uploadBlobs(service, postFiles, powFor, append))) return;
        const sig = signPost(id.privHex, id.pubHex, day, body, parent, refs);
        const pow = await powFor(
          service,
          id.pubHex,
          postPowPayload(
            body,
            parent,
            refs.map((r) => r.id),
          ),
        );
        const req = buildPostRequest({
          author: id.pubHex,
          day,
          body: new TextDecoder().decode(body),
          parent,
          refs,
          sig,
          pow,
        });
        const res = await fetchNym(service, {
          method: 'POST',
          ...req,
          headers: JSON_HEADERS,
        });
        if (res.error) append(`post rejected: ${res.error}`);
        else {
          append(parent ? 'reply posted' : 'posted');
          setDraft('');
          setReplyTo(null);
          setPostFiles([]);
          // The new post carries a higher seq than the cursor, so the next
          // forward poll picks it up — no need to re-walk from genesis.
          await refreshFeed();
        }
      });
    } catch (err) {
      append(`post failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [service, draft, postFiles, replyTo, authed, refreshFeed, append, powFor, setBusy]);

  return {
    draft,
    setDraft,
    postFiles,
    setPostFiles,
    replyTo,
    startReply,
    cancelReply,
    composerRef,
    onPost,
  };
}
