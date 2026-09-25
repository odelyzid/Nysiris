/**
 * Attachment upload driver: pushes prepared blobs to the provider over the
 * tunnel, one envelope per chunk. Parts upload in parallel (concurrency 3)
 * and are matched by echoed correlation tags; each part carries PoW bound
 * to `id || part || chunk`, mirroring the provider. Blobs are idempotent
 * (content-addressed), so re-uploads are harmless. Returns false when any
 * part fails — the caller must abort the send, never post a dangling ref.
 *
 * Talks to the tunnel, so it is not imported by `node --test` (the pure
 * protocol lives in `./blobUpload.ts` and is covered there).
 */
import { fetchNymParallel } from '../../mixnet/fetchNym';
import { BLOB_MAX_PARTS, BLOB_PART_BYTES, blobPartBody, blobPartCount, blobPartPreimage } from '../../domain/blobUpload';
import type { PreparedAttachment } from '../../domain/attachmentCrypto';

export async function uploadBlobs(
  service: string,
  prepared: PreparedAttachment[],
  powFor: (serviceAddr: string, keyHex: string, payload: Uint8Array) => Promise<unknown>,
  onNote: (line: string) => void,
): Promise<boolean> {
  // Proofs first (CPU-local, fast): every part needs one, and proving up
  // front keeps the network phase purely parallel.
  const jobs: { path: string; body: Uint8Array }[] = [];
  for (const p of prepared) {
    const parts = blobPartCount(p.blob.length);
    if (parts > BLOB_MAX_PARTS) {
      onNote('File too large (max 256 KB)');
      return false;
    }
    for (let i = 0; i < parts; i += 1) {
      const chunk = p.blob.slice(i * BLOB_PART_BYTES, (i + 1) * BLOB_PART_BYTES);
      try {
        const pow = await powFor(service, p.id, blobPartPreimage(p.id, i, chunk));
        jobs.push(blobPartBody(p.id, i, parts, chunk, pow));
      } catch (err) {
        onNote(`attachment proof failed: ${String(err)}`);
        return false;
      }
    }
  }
  if (jobs.length === 0) return true;
  let responses;
  try {
    responses = await fetchNymParallel(
      service,
      jobs.map((j) => ({
        method: 'POST',
        path: j.path,
        headers: { 'content-type': 'application/json' },
        body: j.body,
      })),
      { concurrency: 3 },
    );
  } catch (err) {
    onNote(`attachment upload failed: ${String(err)}`);
    return false;
  }
  for (const res of responses) {
    if (res.error) {
      onNote(`attachment upload rejected: ${res.error}`);
      return false;
    }
  }
  return true;
}
