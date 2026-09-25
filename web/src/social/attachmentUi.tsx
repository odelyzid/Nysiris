/**
 * Attachment composer + viewer for posts and DMs.
 *
 * - `AttachmentPicker`: paperclip button, file input, compact chips with
 *   remove, inline validation errors. Owns no network: it hands prepared
 *   (encrypted) attachments up and lets the caller upload on send.
 * - `AttachmentList`: renders refs under a post/message body. Blobs are
 *   fetched once per id (module cache), decrypted locally, and shown as
 *   thumbnails (blurred until clicked) or download chips.
 *
 * Rendering + effects only. Upload protocol lives in `./blobUpload.ts` /
 * `./blobUploadIo.ts`, attachment crypto in `./attachmentCrypto.ts`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { b64decode } from '../lib/bytes';
import { fetchNym } from '../mixnet/fetchNym';
import { MAX_ATTACHMENTS_PER_MESSAGE, parseAttachmentRefs, validateFile, type AttachmentRef } from './attachments.mjs';
import { decryptAttachment, encryptAttachment, type AllowedMime, type PreparedAttachment } from './attachmentCrypto';
import { formatBytes, isImageMime } from './blobUpload';

export type { AttachmentRef, PreparedAttachment } from './attachmentCrypto';
export { parseAttachmentRefs } from './attachments.mjs';

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
