/**
 * Top-level and embedded media player.
 *
 * When the service worker controls the page, the media element loads a
 * `/__nysiris-media/<token>` URL and native Range requests are answered by the
 * app-side bridge through the mixnet. Otherwise it falls back to the already
 * fetched data URL (the pre-Phase-2 behaviour).
 */
import type { CSSProperties } from 'react';
import { useState } from 'react';
import { useStreamUrl } from './useStreamUrl';
import { useOfflineMedia } from './useOfflineMedia';

export function MediaView({
  url,
  contentType,
  dataUrl,
  total,
  etag,
  title,
  zoom,
  onSaveOffline,
}: {
  url: string | null;
  contentType: string;
  dataUrl: string | null;
  total: number | null;
  etag: string | null;
  title: string;
  zoom?: number;
  onSaveOffline?: () => Promise<void>;
}) {
  const streamUrl = useStreamUrl({ url, contentType, total, etag, title }, dataUrl ?? '');
  const offline = useOfflineMedia(url);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const src = offline.url || streamUrl;
  const style = zoom ? ({ zoom } as CSSProperties) : undefined;

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

  if (!src) {
    return (
      <p className="fly-callout-warn" role="alert">
        This media needs the offline shell before it can stream. Reload once, then try again.
      </p>
    );
  }

  return (
    <div className="fly-media-view">
      {contentType.startsWith('video/') ? (
        <video className="fly-portal-media" src={src} controls playsInline aria-label={title} style={style} />
      ) : (
        <audio className="fly-portal-media" src={src} controls aria-label={title} />
      )}
      <div className="fly-row fly-mt-1">
        {onSaveOffline && !offline.url && (
          <button type="button" className="fly-btn fly-btn-sm" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save for offline'}
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
