/**
 * Downloads shelf: recent page downloads with save-again/remove actions.
 *
 * Only metadata is persisted; bytes are written to disk when the download
 * completes, and "Save again" re-fetches through the same mixnet transport.
 */
import { formatSize, type DownloadRecord } from '../../../application/downloads';

export function DownloadManager({
  entries,
  onSaveAgain,
  onRemove,
  onClear,
}: {
  entries: DownloadRecord[];
  onSaveAgain: (entry: DownloadRecord) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  if (entries.length === 0) {
    return <p className="fly-muted">No downloads yet. Save a binary, media, or PDF page to start the shelf.</p>;
  }
  return (
    <div>
      <div className="fly-row fly-row-between fly-mb-2">
        <span className="fly-muted">
          {entries.length} recent download{entries.length === 1 ? '' : 's'}
        </span>
        <button className="fly-btn fly-btn-sm" onClick={onClear}>
          Clear shelf
        </button>
      </div>
      <ul className="fly-download-list" aria-live="polite">
        {entries.map((entry) => (
          <li key={entry.id} className="fly-download-row">
            <div className="fly-download-main">
              <strong className="fly-break-word">{entry.name}</strong>
              <span className="fly-muted">
                {formatSize(entry.size)} · {entry.contentType || 'unknown type'} · {statusLabel(entry)}
              </span>
              {entry.error && <span className="fly-download-error">{entry.error}</span>}
              <span className="fly-muted fly-break-all">{entry.url}</span>
            </div>
            <div className="fly-download-actions">
              <button
                className="fly-btn fly-btn-sm"
                onClick={() => onSaveAgain(entry)}
                disabled={entry.status === 'pending' || !entry.url}
              >
                {entry.status === 'pending' ? 'Saving…' : 'Save again'}
              </button>
              <button className="fly-btn fly-btn-sm" onClick={() => onRemove(entry.id)}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusLabel(entry: DownloadRecord): string {
  if (entry.status === 'pending') return 'saving';
  if (entry.status === 'failed') return 'failed';
  return 'saved';
}
