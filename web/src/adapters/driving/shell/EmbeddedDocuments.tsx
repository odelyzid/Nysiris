/**
 * Extracted `<object>`/`<embed>` documents.
 *
 * The live element is never restored. Each card opens the document either in
 * the active tab or in an app-level preview fetched through the same transport.
 */
import type { EmbeddedDocument } from '../../../application/embeddedDocuments';

export function EmbeddedDocuments({
  documents,
  onPreview,
  onOpen,
}: {
  documents: EmbeddedDocument[];
  onPreview: (document: EmbeddedDocument) => void;
  onOpen: (document: EmbeddedDocument) => void;
}) {
  if (documents.length === 0) return null;
  return (
    <section className="fly-card fly-embedded" aria-label="Embedded documents">
      <h2 className="fly-h2-flush">Embedded documents</h2>
      <p className="fly-muted">
        These elements were removed from the page so they cannot load plugins or frames. Open one to fetch it through
        the same mixnet transport.
      </p>
      <ul className="fly-plain-list">
        {documents.map((document) => (
          <li key={document.id} className="fly-embedded-row">
            <div>
              <strong className="fly-break-word">{document.filename}</strong>
              <span className="fly-muted">
                {document.kind === 'blocked' ? 'Blocked' : document.kind} · {document.contentType || 'unknown type'}
              </span>
              {document.reason && <span className="fly-embedded-reason">{document.reason}</span>}
            </div>
            {document.kind !== 'blocked' && (
              <div className="fly-row fly-embedded-actions">
                <button type="button" className="fly-btn fly-btn-sm" onClick={() => onPreview(document)}>
                  Preview
                </button>
                <button type="button" className="fly-btn fly-btn-sm" onClick={() => onOpen(document)}>
                  Open in tab
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
