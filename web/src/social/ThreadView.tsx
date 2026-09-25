import type { ReactNode } from 'react';

/**
 * Dedicated thread view: root post on top, transitive replies in
 * chronological order underneath with a left-border hierarchy. v1 keeps one
 * visual level — no deep nesting.
 *
 * All data comes from the parent (`Social`): this component assembles
 * nothing, it only renders. Missing ancestors are fetched by the parent;
 * this view just states them ("Loading parent…" / "Post not yet
 * available").
 */
export function ThreadView({
  rootId,
  root,
  replies,
  missingIds,
  loadingIds,
  unavailableIds,
  onBack,
  onReply,
  onShareLink,
  renderPost,
}: {
  rootId: string;
  root: { id: string } | null;
  replies: { id: string }[];
  missingIds: string[];
  loadingIds: string[];
  unavailableIds: string[];
  onBack: () => void;
  onReply: (postId: string) => void;
  /** When provided, a "Copy link" button renders next to the back button. */
  onShareLink?: () => void;
  renderPost: (post: { id: string }) => ReactNode;
}) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <button className="fly-btn" style={{ fontSize: 12 }} onClick={onBack} aria-label="Back to timeline">
          ← All posts
        </button>
        {onShareLink && (
          <button
            className="fly-btn"
            style={{ fontSize: 12 }}
            onClick={onShareLink}
            title="Copy a link that opens this thread"
          >
            Copy link
          </button>
        )}
        <span style={{ fontSize: 11, color: '#888' }}>
          {replies.length === 0 ? 'No replies yet' : `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
        </span>
      </div>

      {!root ? (
        <p style={{ fontSize: 13, color: '#888' }} role="status">
          {unavailableIds.includes(rootId) ? 'Post not yet available.' : 'Loading post…'}
        </p>
      ) : (
        <div
          style={{
            border: '1px solid #ddd',
            borderRadius: 0,
            padding: '8px 12px',
            marginBottom: 4,
            fontSize: 13,
          }}
        >
          {renderPost(root)}
          <div style={{ marginTop: 4 }}>
            <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => onReply(root.id)}>
              Reply
            </button>
          </div>
        </div>
      )}

      {missingIds.length > 0 && (
        <p style={{ fontSize: 11, color: '#888' }} role="status">
          {missingIds.some((id) => loadingIds.includes(id))
            ? 'Loading parent…'
            : 'Some earlier posts are not yet available.'}{' '}
          {unavailableIds.length > 0 && 'Missing posts will stay marked.'}
        </p>
      )}

      <ul style={{ fontSize: 13, listStyle: 'none', padding: 0, margin: 0 }}>
        {replies.map((reply) => (
          <li
            key={reply.id}
            style={{
              borderLeft: '3px solid #ccc',
              padding: '6px 0 6px 12px',
              marginTop: 6,
            }}
          >
            {renderPost(reply)}
            <div style={{ marginTop: 4 }}>
              <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => onReply(reply.id)}>
                Reply
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
