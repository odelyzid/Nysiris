/**
 * PDF viewer for a top-level `application/pdf` page.
 *
 * The fetched bytes arrive as a data URL (see `App.tsx`). Blob URLs are used
 * for the iframe so Chromium's built-in PDF viewer can handle the document
 * without navigating the app to a `data:` URL. The blob is revoked on change.
 */
import { useEffect, useState } from 'react';
import { b64decode } from '../../../lib/bytes';

export function PdfView({ dataUrl, title }: { dataUrl: string; title: string }) {
  const [url, setUrl] = useState('');

  useEffect(() => {
    const match = /^data:application\/pdf;base64,(.*)$/s.exec(dataUrl);
    if (!match) {
      setUrl('');
      return;
    }
    const bytes = b64decode(match[1]);
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const blobUrl = URL.createObjectURL(new Blob([copy.buffer], { type: 'application/pdf' }));
    setUrl(blobUrl);
    return () => URL.revokeObjectURL(blobUrl);
  }, [dataUrl]);

  if (!url) return <p className="fly-muted">Preparing PDF…</p>;
  return <iframe className="fly-pdf-frame" src={url} title={title || 'PDF document'} referrerPolicy="no-referrer" />;
}
