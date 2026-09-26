import { describeSync } from '../../../../application/sync';

/**
 * One live line describing feed freshness, with a Retry action on error.
 * Polling status is fed in by `useCommunityFeed`.
 */
export function SyncLine({
  nowTick,
  syncing,
  lastSyncedAt,
  error,
  stopped,
  busy,
  onRetry,
}: {
  nowTick: number;
  syncing: boolean;
  lastSyncedAt: number | null;
  error: string | null;
  /** Automatic retries are paused (definitive service error). */
  stopped?: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  const sync = describeSync(nowTick, { syncing, lastSyncedAt, error, stopped });
  const tone = sync.tone === 'bad' ? 'var(--fly-bad)' : sync.tone === 'busy' ? 'var(--fly-warn)' : 'var(--fly-muted)';
  return (
    <p style={{ fontSize: 11, color: tone }} role="status">
      {sync.text}{' '}
      {error && (
        <button className="fly-btn" style={{ fontSize: 11 }} onClick={onRetry} disabled={busy}>
          Retry
        </button>
      )}
    </p>
  );
}
