import { BACKUP_MIN_PASSWORD_LENGTH } from '../../../../application/identityStore';
import type { IdentitySession } from '../hooks/useIdentitySession';

/**
 * Advanced identity panel (behind the ··· toggle): full ID + QR + copy, move
 * via raw secret, and encrypted file backup/restore.
 */
export function IdentityPanel({ session, busy }: { session: IdentitySession; busy: boolean }) {
  const { identity, idCopied, showIdQr, idQrUrl, profileName, importKey, backupPw, restorePw, restoreFile } = session;
  if (!identity) return null;
  return (
    <div className="fly-identity-panel">
      <div>
        Full ID: <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{identity.pubHex}</code>{' '}
        <button style={{ fontSize: 11 }} className="fly-btn" onClick={session.onCopyId}>
          {idCopied ? 'Copied' : 'Copy my ID'}
        </button>{' '}
        <button
          style={{ fontSize: 11 }}
          onClick={session.onToggleIdQr}
          aria-expanded={showIdQr}
          className="fly-btn"
        >
          {showIdQr ? 'Hide QR' : 'Show QR'}
        </button>{' '}
        <button style={{ fontSize: 11 }} className="fly-btn" onClick={session.onNewIdentity}>
          New ID
        </button>
      </div>
      <details>
        <summary>Show technical details</summary> <code style={{ fontSize: 11 }}>{identity.pubHex}</code>
      </details>
      {!profileName.trim() && (
        <p className="fly-identity-tip">
          Tip: set your display name under About → Your profile so others recognize you.
        </p>
      )}
      {showIdQr && (
        <div style={{ marginTop: 8 }}>
          {idQrUrl ? (
            <img className="fly-qr" src={idQrUrl} alt="QR code for your private ID" width={220} height={220} />
          ) : (
            <p className="fly-muted" role="status">
              Making your QR code…
            </p>
          )}
          <p className="fly-muted">Others scan this to message you. The code is made on this device.</p>
        </div>
      )}
      <details>
        <summary>Move my ID to another device</summary>
        <p style={{ fontSize: 11, color: 'var(--fly-muted)', margin: '4px 0' }}>
          Step 1 — on this device, reveal and copy your secret key. Step 2 — on the other device, paste it below.
          Anyone with this key is you: never share it with another person.
        </p>
        <div style={{ marginBottom: 4 }}>
          {!session.showSecret ? (
            <button className="fly-btn" style={{ fontSize: 11 }} onClick={session.onRevealSecret}>
              Reveal secret key
            </button>
          ) : (
            <span style={{ wordBreak: 'break-all' }}>
              <code style={{ fontSize: 11 }}>{identity.privHex}</code>{' '}
              <button style={{ fontSize: 11 }} className="fly-btn" onClick={session.onCopySecret}>
                {session.secretCopied ? 'Copied' : 'Copy secret'}
              </button>{' '}
              <button style={{ fontSize: 11 }} onClick={session.onHideSecret} className="fly-btn">
                Hide
              </button>
            </span>
          )}
        </div>
        <input
          style={{ marginLeft: 8, width: 200 }}
          placeholder="paste secret key"
          className="fly-input"
          value={importKey}
          onChange={(e) => session.setImportKey(e.target.value)}
          spellCheck={false}
        />
        <button style={{ fontSize: 11 }} className="fly-btn" onClick={session.onImportIdentity}>
          Import
        </button>
      </details>
      <details>
        <summary>Back up / restore (encrypted file)</summary>
        <p style={{ fontSize: 11, color: 'var(--fly-muted)', margin: '4px 0' }}>
          Password-encrypted copy of your secret key — easier than raw hex on a new device. Anyone with this file{' '}
          <em>and</em> the password is you: store them separately.
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="password"
            style={{ width: 200 }}
            className="fly-input"
            placeholder={`backup password (${BACKUP_MIN_PASSWORD_LENGTH}+ chars)`}
            value={backupPw}
            onChange={(e) => session.setBackupPw(e.target.value)}
            autoComplete="new-password"
            aria-label="Backup password"
          />
          <button
            style={{ fontSize: 11 }}
            className="fly-btn"
            onClick={() => void session.onExportBackup()}
            disabled={busy || backupPw.length < BACKUP_MIN_PASSWORD_LENGTH}
          >
            Download backup
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            ref={session.restoreFileRef}
            type="file"
            accept=".json,application/json"
            style={{ fontSize: 11 }}
            aria-label="Backup file"
            onChange={(e) => session.setRestoreFile(e.target.files?.[0] ?? null)}
          />
          <input
            type="password"
            style={{ width: 200 }}
            className="fly-input"
            placeholder="backup password"
            value={restorePw}
            onChange={(e) => session.setRestorePw(e.target.value)}
            autoComplete="current-password"
            aria-label="Restore password"
          />
          <button
            style={{ fontSize: 11 }}
            className="fly-btn"
            onClick={() => void session.onRestoreBackup()}
            disabled={busy || !restoreFile || !restorePw}
          >
            Restore
          </button>
        </div>
      </details>
    </div>
  );
}
