import type { Contact } from './contacts';

export interface PendingInvite {
  address: string;
  path: string;
  inviter: string;
  note: string;
  /** Full parsed invite (with signature) for verification on accept. */
  invite: {
    service: string;
    inviter: string;
    note: string;
    sig: string;
    vouches?: string[];
  };
}

/**
 * Contacts panel: saved addresses plus the pending invite banner.
 * Visiting a contact navigates the URI bar (same path as pasting a link).
 */
export function ContactsPanel({
  contacts,
  pending,
  onVisit,
  onRemove,
  onAccept,
  onDismissInvite,
  onTrustVouched,
  petname,
  onPetnameChange,
}: {
  contacts: Contact[];
  pending: PendingInvite | null;
  onVisit: (address: string) => void;
  onRemove: (name: string) => void;
  onAccept: () => void;
  onDismissInvite: () => void;
  /** Trust every vouched ID at once. Provided by App (owns the verdicts). */
  onTrustVouched?: (authors: string[]) => void;
  petname: string;
  onPetnameChange: (name: string) => void;
}) {
  return (
    <div>
      {pending && (
        <div
          style={{
            border: '1px solid #bd5b4e',
            borderRadius: 0,
            padding: 8,
            marginBottom: 8,
            fontSize: 13,
          }}
        >
          <div>
            Invited by <code style={{ wordBreak: 'break-all' }}>{pending.inviter.slice(0, 20)}…</code>
          </div>
          <div style={{ color: '#666' }}>“{pending.note}”</div>
          {pending.invite.vouches && pending.invite.vouches.length > 0 && (
            <div
              style={{ color: '#666' }}
              title="IDs the inviter explicitly trusts. Signed into the invite — but verify out-of-band before trusting them yourself."
            >
              Vouched by inviter ({pending.invite.vouches.length}):{' '}
              <code style={{ wordBreak: 'break-all' }}>
                {pending.invite.vouches.map((v) => `${v.slice(0, 12)}…`).join(', ')}
              </code>{' '}
              {onTrustVouched && (
                <button
                  className="fly-btn"
                  style={{ fontSize: 11 }}
                  title="Record your own trust verdict for every vouched ID"
                  onClick={() => onTrustVouched(pending.invite.vouches ?? [])}
                >
                  Trust all
                </button>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              className="fly-input"
              style={{ flex: 1 }}
              placeholder="save as… (petname)"
              value={petname}
              onChange={(e) => onPetnameChange(e.target.value)}
              spellCheck={false}
            />
            <button className="fly-btn fly-btn-primary" onClick={onAccept} disabled={!petname.trim()}>
              Save
            </button>
            <button className="fly-btn" onClick={onDismissInvite}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {contacts.length === 0 && !pending && (
        <p style={{ fontSize: 13, color: '#666' }}>
          No people yet. Open a private invite link — saving it adds the person here under a name you choose.
        </p>
      )}
      <ul style={{ fontSize: 13, listStyle: 'none', padding: 0, margin: 0 }}>
        {contacts.map((c) => (
          <li key={c.name} style={{ borderTop: '1px solid #eee', padding: '6px 0' }}>
            <strong>{c.name}</strong>{' '}
            <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{c.address.slice(0, 24)}…</code>
            {c.note && <div style={{ color: '#666' }}>“{c.note}”</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => onVisit(c.address)}>
                Visit
              </button>
              <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => onRemove(c.name)}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
