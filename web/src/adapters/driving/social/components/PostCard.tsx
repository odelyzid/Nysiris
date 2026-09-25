import type { ReactNode } from 'react';

/**
 * One timeline row: a clickable post body plus the View thread / Reply
 * actions. The body node is rendered by the caller (see `PostBody`).
 */
export function PostCard({
  replyCount,
  onOpenThread,
  onReply,
  children,
}: {
  replyCount: number;
  onOpenThread: () => void;
  onReply: () => void;
  children: ReactNode;
}) {
  return (
    <li>
      <span
        role="button"
        tabIndex={0}
        onClick={onOpenThread}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onOpenThread();
        }}
        title="Open thread"
        style={{ cursor: 'pointer', display: 'block' }}
      >
        {children}
      </span>
      <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
        {replyCount > 0 && (
          <button
            className="fly-btn"
            style={{ fontSize: 11 }}
            onClick={onOpenThread}
            aria-label={`View thread with ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
          >
            {replyCount} {replyCount === 1 ? 'reply' : 'replies'} · View thread
          </button>
        )}
        <button className="fly-btn" style={{ fontSize: 11 }} onClick={onReply}>
          Reply
        </button>
      </div>
    </li>
  );
}
