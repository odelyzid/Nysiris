/**
 * Attachment composer + viewer for posts and DMs.
 *
 * - `AttachmentPicker`: paperclip button, file input, compact chips with
 *   remove, inline validation errors. Owns no network: it hands prepared
 *   (encrypted) attachments up and lets the caller upload on send.
 * - `AttachmentList`: renders refs under a post/message body. Blobs are
 *   fetched once per id (module cache), decrypted locally, and shown as
 *   thumbnails (blurred until clicked) or download chips.
 * - `uploadBlobs`: POSTs prepared blobs in 44 KiB chunks to
 *   `/blob/part` (request envelopes are capped at 64 KiB), each part with
 *   PoW bound to `id || index || bytes`, mirroring the provider.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { hexToBytes } from '@noble/hashes/utils.js';
import { fetchNym, fetchNymParallel, type FetchNymRequest } from '../mixnet/fetchNym';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  parseAttachmentRefs,
  validateFile,
  type AttachmentRef,
} from './attachments.mjs';
import { decryptAttachment, encryptAttachment, type AllowedMime, type PreparedAttachment } from './attachmentCrypto';

export type { AttachmentRef, PreparedAttachment };
export { parseAttachmentRefs };

/** Upload chunk size: request envelopes are capped at 64 KiB, so blobs
 * travel as one envelope per chunk. Mirrors `attach::MAX_BLOB_PART_BYTES`. */
export const BLOB_PART_BYTES = 45_056;
export const BLOB_MAX_PARTS = 8;

function b64encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function b64decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function isImageMime(mime: string): boolean {
  return mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp' || mime === 'image/gif';
}

/* ------------------------------------------------------------ uploading */

/**
 * Store prepared blobs on the provider, one envelope per chunk (request
 * bodies are capped at 64 KiB). Parts upload in parallel (concurrency 3)
 * and are matched by echoed correlation tags; each part carries PoW bound
 * to `id || part || chunk`, mirroring the provider. Blobs are idempotent
 * (content-addressed), so re-uploads are harmless. Returns false when any
 * part fails — the caller must abort the send, never post a dangling ref.
 */
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
    const parts = Math.ceil(p.blob.length / BLOB_PART_BYTES);
    if (parts > BLOB_MAX_PARTS) {
      onNote('File too large (max 256 KB)');
      return false;
    }
    const idBytes = hexToBytes(p.id);
    for (let i = 0; i < parts; i += 1) {
      const chunk = p.blob.slice(i * BLOB_PART_BYTES, (i + 1) * BLOB_PART_BYTES);
      const preimage = new Uint8Array(idBytes.length + 4 + chunk.length);
      preimage.set(idBytes, 0);
      new DataView(preimage.buffer).setUint32(idBytes.length, i);
      preimage.set(chunk, idBytes.length + 4);
      try {
        const pow = await powFor(service, p.id, preimage);
        jobs.push({
          path: `/blob/part?id=${p.id}&part=${i}&of=${parts}`,
          body: new TextEncoder().encode(
            JSON.stringify({ bytes_b64: b64encode(chunk), ...(pow ? { pow } : {}) }),
          ),
        });
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

/* -------------------------------------------------------------- picker */

export function AttachmentPicker({
  files,
  onChange,
  onError,
  disabled,
  inputId,
}: {
  files: PreparedAttachment[];
  onChange: (next: PreparedAttachment[]) => void;
  onError: (line: string) => void;
  disabled: boolean;
  /** Unique DOM id for the hidden file input (two pickers share this view). */
  inputId: string;
}) {
  const [encrypting, setEncrypting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onPick = useCallback(
    async (picked: FileList | null) => {
      if (!picked || picked.length === 0) return;
      if (files.length + picked.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        onError(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
        return;
      }
      setEncrypting(true);
      try {
        const next = [...files];
        for (const file of Array.from(picked)) {
          if (next.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
            onError(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
            break;
          }
          let name: string;
          try {
            const buf = new Uint8Array(await file.arrayBuffer());
            name = validateFile(file.name, file.type, buf.length);
            const prepared = await encryptAttachment(name, file.type as AllowedMime, buf);
            next.push(prepared);
          } catch (err) {
            onError(String(err instanceof Error ? err.message : err));
          }
        }
        onChange(next);
      } finally {
        setEncrypting(false);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [files, onChange, onError],
  );

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple
        style={{ display: 'none' }}
        aria-label="Attach files"
        onChange={(e) => void onPick(e.target.files)}
      />
      <button
        className="fly-btn"
        style={{ fontSize: 12 }}
        title="Attach files (images, text, PDF — max 256 KB each, 3 per message)"
        disabled={disabled || encrypting}
        onClick={() => inputRef.current?.click()}
      >
        {encrypting ? 'Encrypting…' : '📎 Attach'}
      </button>
      {files.map((f) => (
        <span
          key={f.id}
          style={{
            display: 'inline-flex',
            gap: 4,
            alignItems: 'center',
            fontSize: 11,
            border: '1px solid var(--fly-line)',
            padding: '2px 4px 2px 8px',
          }}
          title={`${f.mime}, ${formatBytes(f.size)}`}
        >
          {f.name} · {formatBytes(f.size)}
          <button
            className="fly-btn"
            style={{ fontSize: 11, minHeight: 24, padding: '0 6px' }}
            aria-label={`Remove ${f.name}`}
            disabled={disabled}
            onClick={() => onChange(files.filter((x) => x.id !== f.id))}
          >
            ✕
          </button>
        </span>
      ))}
    </span>
  );
}

/* -------------------------------------------------------------- viewer */

interface BlobState {
  status: 'loading' | 'ready' | 'missing';
  url: string | null;
  bytes: Uint8Array | null;
}

/** Process-wide blob cache: one download + one object URL per content id. */
const blobCache = new Map<string, Promise<BlobState>>();

function fetchBlob(service: string, ref: AttachmentRef): Promise<BlobState> {
  const hit = blobCache.get(ref.id);
  if (hit) return hit;
  const task = (async (): Promise<BlobState> => {
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

function AttachmentCard({ service, ref }: { service: string; ref: AttachmentRef }) {
  const [state, setState] = useState<BlobState>({ status: 'loading', url: null, bytes: null });
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', url: null, bytes: null });
    setRevealed(false);
    void fetchBlob(service, ref).then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, [service, ref]);

  if (state.status === 'loading') {
    return <span style={{ fontSize: 11, color: '#888' }}>Loading {ref.name}…</span>;
  }
  if (state.status === 'missing' || !state.url) {
    return (
      <span style={{ fontSize: 11, color: '#888' }} title="The blob is gone or undecryptable">
        📎 {ref.name} — Attachment unavailable
      </span>
    );
  }
  if (isImageMime(ref.mime)) {
    const url = state.url as string;
    return (
      <span style={{ display: 'inline-block', maxWidth: 220 }}>
        <img
          src={url}
          alt={ref.name}
          title={revealed ? ref.name : `${ref.name} — click to reveal`}
          style={{
            display: 'block',
            maxWidth: '100%',
            maxHeight: 140,
            cursor: revealed ? 'zoom-in' : 'pointer',
            filter: revealed ? 'none' : 'blur(8px)',
          }}
          onClick={() => {
            if (!revealed) setRevealed(true);
            else window.open(url, '_blank', 'noopener');
          }}
        />
        <span style={{ fontSize: 11, color: '#888' }}>
          {ref.name} · {formatBytes(ref.size)}
        </span>
      </span>
    );
  }
  return (
    <a
      href={state.url}
      download={ref.name}
      style={{ fontSize: 12 }}
      title={`${ref.mime}, ${formatBytes(ref.size)} — decrypted on this device`}
    >
      📎 {ref.name} · {formatBytes(ref.size)}
    </a>
  );
}

export function AttachmentList({ service, refs }: { service: string; refs: AttachmentRef[] }) {
  let safe: AttachmentRef[];
  try {
    safe = parseAttachmentRefs(refs);
  } catch {
    return null; // Cached garbage or tampered refs: render nothing, never crash.
  }
  if (safe.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
      {safe.map((r) => (
        <AttachmentCard key={r.id} service={service} ref={r} />
      ))}
    </div>
  );
}
