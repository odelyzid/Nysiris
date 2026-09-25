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
  busy,
  onRetry,
}: {
  nowTick: number;
  syncing: boolean;
  lastSyncedAt: number | null;
  error: string | null;
  busy: boolean;
  onRetry: () => void;
}) {
  const sync = describeSync(nowTick, { syncing, lastSyncedAt, error });
  const tone = sync.tone === 'bad' ? '#b00020' : sync.tone === 'busy' ? '#b26b00' : '#888';
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
