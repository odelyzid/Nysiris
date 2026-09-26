import { useState } from 'react';
import type { TunnelStateView } from '../../../mixnet/tunnel';
import { friendlyError, statusHeadline } from '../../../shared/friendlyErrors';

/**
 * Discreet protection pill. Shows one of Protected / Connecting… /
 * Not protected / Something went wrong; clicking reveals one friendly
 * sentence, a recovery action, and collapsed technical details.
 */
export function StatusPill({
  status,
  detail,
  onRetry,
  busy,
}: {
  status: TunnelStateView;
  detail?: string;
  onRetry: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { title, help } = statusHeadline(status.state);

  const tone =
    status.state === 'ready'
      ? 'var(--fly-good)'
      : status.state === 'shutdown'
        ? 'var(--fly-muted)'
        : status.state === 'failed'
          ? 'var(--fly-bad)'
          : 'var(--fly-warn)';

  const pillLabel =
    status.state === 'ready'
      ? 'Protected'
      : status.state === 'connecting'
        ? 'Connecting…'
        : status.state === 'shutting_down'
          ? 'Switching off…'
          : status.state === 'shutdown'
            ? 'Not protected'
            : 'Something went wrong';

  const raw = detail ?? (status.state === 'failed' ? (status.reason ?? '') : '');
  const friendly = raw ? friendlyError(raw) : null;

  return (
    <span style={{ marginLeft: 'auto', position: 'relative' }}>
      <button className="fly-status" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={title}>
        <span className="fly-status-dot" aria-hidden="true" style={{ backgroundColor: tone }} />
        {pillLabel}
      </button>
      {open && (
        <span
          role="dialog"
          aria-label="Connection details"
          className="fly-card"
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            zIndex: 30,
            width: 'min(320px, 80vw)',
            marginTop: 8,
            marginBottom: 0,
          }}
        >
          <strong style={{ fontSize: 15 }}>{title}</strong>
          <p style={{ margin: '8px 0' }}>{friendly?.help ?? help}</p>
          {status.state !== 'ready' && (
            <span className="fly-row">
              <button className="fly-btn fly-btn-primary" onClick={onRetry} disabled={busy}>
                {friendly?.action ?? 'Try again'}
              </button>
            </span>
          )}
          {raw && (
            <details style={{ marginTop: 8 }}>
              <summary className="fly-muted" style={{ cursor: 'pointer' }}>
                Technical details
              </summary>
              <pre
                style={{
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  marginTop: 8,
                }}
              >
                {raw}
              </pre>
              <button
                className="fly-btn"
                style={{ fontSize: 13, minHeight: 36, padding: '6px 12px' }}
                onClick={() => {
                  void navigator.clipboard?.writeText(raw).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
              >
                {copied ? 'Copied' : 'Copy error'}
              </button>
            </details>
          )}
        </span>
      )}
    </span>
  );
}
