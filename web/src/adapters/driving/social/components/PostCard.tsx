import type { ReactNode } from 'react';

/**
 * One timeline row: a post body plus explicit Thread / Reply actions.
 *
 * The body is deliberately not a click target: post bodies contain their own
 * buttons (Name, Trust, Block, attachments), and a row-level role="button"
 * both nests interactive controls and swallows those clicks. Keyboard users
 * get the same actions through the plain buttons below.
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
      <div className="fly-post-body">{children}</div>
      <div className="fly-post-actions">
        <button
          className="fly-btn fly-btn-sm"
          onClick={onOpenThread}
          aria-label={
            replyCount > 0
              ? `Open thread with ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`
              : 'Open thread'
          }
        >
          Thread{replyCount > 0 ? ` · ${replyCount}` : ''}
        </button>
        <button className="fly-btn fly-btn-sm" onClick={onReply}>
          Reply
        </button>
      </div>
    </li>
  );
}
