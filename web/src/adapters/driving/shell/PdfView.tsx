/**
 * PDF viewer for a top-level or embedded `application/pdf` document.
 *
 * When the range bridge is available, Chromium's built-in viewer loads a
 * `/__nysiris-media/<token>` URL and ranges travel through the mixnet. The data
 * URL fallback keeps working on the first load / without a service worker.
 */
import { useEffect, useState } from 'react';
import { b64decode } from '../../../lib/bytes';
import { useStreamUrl } from './useStreamUrl';
import { useOfflineMedia } from './useOfflineMedia';

export function PdfView({
  dataUrl,
  title,
  url = null,
  total = null,
  etag = null,
  onSaveOffline,
}: {
  dataUrl: string;
  title: string;
  url?: string | null;
  total?: number | null;
  etag?: string | null;
  onSaveOffline?: () => Promise<void>;
}) {
  const [blobUrl, setBlobUrl] = useState('');
  const streamUrl = useStreamUrl({ url, contentType: 'application/pdf', total, etag, title }, '');
  const offline = useOfflineMedia(url);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    const match = /^data:application\/pdf;base64,(.*)$/s.exec(dataUrl);
    if (!match) {
      setBlobUrl('');
      return;
    }
    const bytes = b64decode(match[1]);
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const objectUrl = URL.createObjectURL(new Blob([copy.buffer], { type: 'application/pdf' }));
    setBlobUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [dataUrl]);

  const source = offline.url || streamUrl || blobUrl;
  if (!source) return <p className="fly-muted">Preparing PDF…</p>;

  const save = async () => {
    if (!onSaveOffline || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      await onSaveOffline();
      offline.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fly-pdf-view">
      <iframe className="fly-pdf-frame" src={source} title={title || 'PDF document'} referrerPolicy="no-referrer" />
      <div className="fly-row fly-mt-1">
        {onSaveOffline && !offline.url && (
          <button type="button" className="fly-btn fly-btn-sm" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save PDF for offline'}
          </button>
        )}
        {offline.url && <span className="fly-muted">Saved offline</span>}
        {saveError && (
          <span className="fly-callout-warn" role="alert">
            {saveError}
          </span>
        )}
      </div>
    </div>
  );
}
