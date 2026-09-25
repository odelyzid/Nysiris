import type { ReactNode } from 'react';
import { countDescendants } from '../../../../domain/threads';
import { ThreadView } from '../ThreadView';
import { EmptyState } from './EmptyState';
import { PostCard } from './PostCard';
import { SyncLine } from './SyncLine';
import { TimelineComposer } from './TimelineComposer';
import { TrustLegend } from './TrustLegend';
import type { CommunityFeed } from '../hooks/useCommunityFeed';
import type { PostComposer } from '../hooks/usePostComposer';
import type { Post } from '../model';

/** Timeline tab: composer, trust legend, sync line, and the post list. */
export function TimelineView({
  service,
  feed,
  composer,
  replyToLabel,
  busy,
  trustedOnly,
  onToggleTrustedOnly,
  visiblePosts,
  renderPost,
  onBeFirst,
  onError,
}: {
  service: string;
  feed: CommunityFeed;
  composer: PostComposer;
  replyToLabel: string | null;
  busy: boolean;
  trustedOnly: boolean;
  onToggleTrustedOnly: () => void;
  visiblePosts: Post[];
  renderPost: (post: Post) => ReactNode;
  onBeFirst: () => void;
  onError: (line: string) => void;
}) {
  return (
    <div role="tabpanel" aria-label="Timeline">
      <TimelineComposer
        replyTo={composer.replyTo}
        replyToLabel={replyToLabel}
        draft={composer.draft}
        onDraftChange={composer.setDraft}
        onPost={() => void composer.onPost()}
        busy={busy}
        postFiles={composer.postFiles}
        onPostFilesChange={composer.setPostFiles}
        onError={onError}
        onCancelReply={composer.cancelReply}
        composerRef={composer.composerRef}
      />

      <h3 className="section-title">Timeline</h3>
      <p style={{ fontSize: 11, color: '#888' }}>
        Global chronological timeline — every post is checked before it appears, so fakes never show.
      </p>
      <div style={{ margin: '4px 0 8px' }}>
        <button
          className="fly-btn"
          style={{ fontSize: 12 }}
          aria-pressed={trustedOnly}
          title="Hide posts from authors you have not trusted"
          onClick={onToggleTrustedOnly}
        >
          {trustedOnly ? 'Showing trusted only ✓' : 'Show: everyone'}
        </button>
      </div>
      <TrustLegend />
      <SyncLine
        nowTick={feed.nowTick}
        syncing={feed.syncing}
        lastSyncedAt={feed.lastSyncedAt}
        error={feed.feedError}
        busy={busy}
        onRetry={() => void feed.refreshFeed()}
      />
      {Number.isFinite(feed.oldestSeq) && feed.oldestSeq > 1 && (
        <div style={{ marginBottom: 8 }}>
          <button
            className="fly-btn"
            style={{ fontSize: 11 }}
            onClick={() => void feed.loadOlder()}
            disabled={feed.loadingOlder || busy}
          >
            {feed.loadingOlder ? 'Loading older…' : 'Load older posts'}
          </button>
        </div>
      )}

      {feed.posts.length === 0 && !feed.syncing && !feed.feedError ? (
        <EmptyState
          glyph="💬"
          title="Nothing here yet"
          action={
            <button className="fly-btn fly-btn-primary" onClick={onBeFirst}>
              Be the first to post
            </button>
          }
        >
          <p>
            {service
              ? 'This community is quiet. Say the first word — it stays signed by your ID.'
              : 'Open a private link above to join a community, then come back here.'}
          </p>
        </EmptyState>
      ) : feed.openThreadId && feed.activeThread ? (
        <ThreadView
          rootId={feed.openThreadId}
          root={feed.activeThread.root}
          replies={feed.activeThread.replies}
          missingIds={feed.activeThreadMissingIds}
          loadingIds={feed.fetchingIds}
          unavailableIds={feed.unavailableIds}
          onBack={feed.closeThread}
          onShareLink={feed.shareThreadLink}
          onReply={(postId) => {
            const target = feed.postsById.get(postId);
            if (target) composer.startReply(target);
          }}
          renderPost={(node) => {
            const full = feed.postsById.get(node.id);
            return full ? renderPost(full) : null;
          }}
        />
      ) : (
        <ul className="fly-timeline-list">
          {visiblePosts.map((p) => {
            const replyCount = countDescendants(p.id, feed.threadNodes);
            return (
              <PostCard
                key={p.seq}
                replyCount={replyCount}
                onOpenThread={() => feed.showThread(p.id)}
                onReply={() => composer.startReply(p)}
              >
                {renderPost(p)}
              </PostCard>
            );
          })}
        </ul>
      )}
    </div>
  );
}
