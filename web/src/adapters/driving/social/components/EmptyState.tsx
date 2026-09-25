import type { ReactNode } from 'react';

/** Calm empty-state block shared by the timeline and the DM pane. */
export function EmptyState({
  glyph,
  title,
  children,
  action,
}: {
  glyph: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="fly-empty">
      <span className="fly-empty-glyph" aria-hidden="true">
        {glyph}
      </span>
      <strong>{title}</strong>
      {children}
      {action}
    </div>
  );
}
