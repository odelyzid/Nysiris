import type { ReactNode } from 'react';

/**
 * A toolbar-controlled window: title bar with a close button, content below.
 * Closing a panel never stops background work (tunnel, polling, inbox) — it
 * only hides the view. State is preserved while the page lives.
 */
export function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <section
      style={{
        border: '1px solid #ddd',
        borderRadius: 0,
        padding: 12,
        marginBottom: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 15 }}>{title}</strong>
        <button
          className="fly-btn"
          onClick={onClose}
          aria-label={`Close ${title}`}
          title={`Close ${title}`}
          style={{ fontSize: 12, padding: '2px 8px' }}
        >
          Close
        </button>
      </div>
      {children}
    </section>
  );
}
