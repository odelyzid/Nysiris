import type { IdentitySession } from '../hooks/useIdentitySession';
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
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Community</h2>
      <button onClick={onRefresh} disabled={busy} className="fly-btn">
        Refresh
      </button>
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        {!session.identity ? (
          <div className="fly-row" style={{ alignItems: 'center' }}>
            <span style={{ wordBreak: 'break-word' }}>
              You need a private ID to post or receive messages — one tap creates it on this device.
            </span>
            <button className="fly-btn fly-btn-primary" onClick={session.onCreateIdentity}>
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
