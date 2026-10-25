import type { IdentitySession } from '../hooks/useIdentitySession';
import { RefreshIcon } from '../../shared/icons';
import { IdentityBar } from './IdentityBar';
import { IdentityPanel } from './IdentityPanel';

/** Community header: title, refresh, and the identity area. */
export function CommunityHeader({
  session,
  busy,
  onRefresh,
}: {
  session: IdentitySession;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <>
      <div className="panel-title">
        <span>Community</span>
        <button className="btn btn-secondary" onClick={onRefresh} disabled={busy}>
          <RefreshIcon size={13} /> Refresh
        </button>
      </div>
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        {!session.identity ? (
          <div className="fly-row" style={{ alignItems: 'center' }}>
            <span style={{ wordBreak: 'break-word' }}>
              You need a private ID to post or receive messages — one tap creates it on this device.
            </span>
            <button className="btn btn-primary" onClick={session.onCreateIdentity}>
              Create my private ID
            </button>
          </div>
        ) : (
          <>
            <IdentityBar session={session} busy={busy} />
            {session.showIdentity && <IdentityPanel session={session} busy={busy} />}
          </>
        )}
      </div>
    </>
  );
}
