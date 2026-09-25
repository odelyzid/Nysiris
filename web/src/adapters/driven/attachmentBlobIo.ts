/**
 * Attachment blob I/O: download one content-addressed blob over the mixnet and
 * decrypt it locally. Process-wide cache: one download + one object URL per
 * content id, so two views showing the same ref fetch once.
 */
import { b64decode } from '../../lib/bytes';
import { fetchNym } from '../../mixnet/fetchNym';
import { decryptAttachment, type AttachmentRef } from '../../domain/attachmentCrypto';

export interface AttachmentBlob {
  status: 'loading' | 'ready' | 'missing';
  url: string | null;
  bytes: Uint8Array | null;
}

const blobCache = new Map<string, Promise<AttachmentBlob>>();

export function fetchAttachmentBlob(service: string, ref: AttachmentRef): Promise<AttachmentBlob> {
  const hit = blobCache.get(ref.id);
  if (hit) return hit;
  const task = (async (): Promise<AttachmentBlob> => {
    try {
      const res = await fetchNym(service, { method: 'GET', path: `/blob/${ref.id}` });
      if (res.error) return { status: 'missing', url: null, bytes: null };
      const body = JSON.parse(new TextDecoder().decode(res.body)) as { bytes_b64?: unknown };
      if (typeof body.bytes_b64 !== 'string') return { status: 'missing', url: null, bytes: null };
      const plain = await decryptAttachment(ref, b64decode(body.bytes_b64));
      const url = URL.createObjectURL(new Blob([plain as BlobPart], { type: ref.mime }));
      return { status: 'ready', url, bytes: plain };
    } catch {
      return { status: 'missing', url: null, bytes: null };
    }
  })();
  blobCache.set(ref.id, task);
  return task;
}
