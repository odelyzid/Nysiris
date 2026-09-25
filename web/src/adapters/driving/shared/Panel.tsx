import type { ReactNode } from 'react';

/**
 * A toolbar-controlled window: a raised title bar with a close button and
 * content below. Closing a panel never stops background work (tunnel,
 * polling, inbox) — it only hides the view. State is preserved while the
 * page lives.
 */
export function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <section className="panel" aria-label={title}>
      <div className="panel-title">
        <span>{title}</span>
        <button
          className="btn-ghost"
          onClick={onClose}
          aria-label={`Close ${title}`}
          title={`Close ${title}`}
        >
          ✕
        </button>
      </div>
      {children}
    </section>
  );
}
