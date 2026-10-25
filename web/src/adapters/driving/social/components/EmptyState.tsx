import type { ReactNode } from 'react';

/** Calm empty-state block shared by the timeline and the DM pane. */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="fly-empty">
      <span className="fly-empty-glyph" aria-hidden="true">
        {icon}
      </span>
      <strong>{title}</strong>
      {children}
      {action}
    </div>
  );
}
