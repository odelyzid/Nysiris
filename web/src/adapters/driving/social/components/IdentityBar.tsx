import type { IdentitySession } from '../hooks/useIdentitySession';

/**
 * Compact identity bar: short ID, optional invite-vouch toggle, Copy invite
 * link, and the ··· toggle for the advanced panel.
 */
export function IdentityBar({ session, busy }: { session: IdentitySession; busy: boolean }) {
  const { identity, trustedVouches, vouchOnCopy, setVouchOnCopy, showIdentity, onToggleIdentity, onCopyInvite } =
    session;
  if (!identity) return null;
  return (
    <div className="fly-identity-bar">
      <span className="fly-identity-id" title={identity.pubHex}>
        🪪 {identity.pubHex.slice(0, 12)}…
      </span>
      {trustedVouches.length > 0 && (
        <label
          style={{ fontSize: 11, marginRight: 8 }}
          title="Sign your explicit-trust list into the invite so the recipient sees who you vouch for"
        >
          <input type="checkbox" checked={vouchOnCopy} onChange={(e) => setVouchOnCopy(e.target.checked)} /> Vouch for{' '}
          {trustedVouches.length} trusted
        </label>
      )}
      <button
        style={{ fontSize: 11 }}
        className="fly-btn fly-btn-primary"
        title="Sign an invite link for this community and copy it"
        onClick={onCopyInvite}
        disabled={busy}
      >
        Copy invite link
      </button>
      <button
        className="fly-btn"
        style={{ fontSize: 11 }}
        aria-expanded={showIdentity}
        aria-label="Identity options"
        title="Identity options: ID, QR, move, backup"
        onClick={onToggleIdentity}
      >
        ···
      </button>
    </div>
  );
}
