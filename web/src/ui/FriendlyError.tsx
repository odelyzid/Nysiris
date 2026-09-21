import { friendlyError } from './friendlyErrors';

/**
 * Friendly error banner: calm headline + one helpful sentence +
 * recovery action. Raw text stays behind a collapsed disclosure with
 * a Copy button — never in the main view by default.
 */
export function FriendlyError({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  if (!error) return null;
  const friendly = friendlyError(error);
  return (
    <div className="fly-error" role="alert">
      <strong style={{ fontSize: 15 }}>{friendly.title}</strong>
      <p style={{ margin: '4px 0 8px' }}>{friendly.help}</p>
      <div className="fly-row">
        {onRetry && (
          <button className="fly-btn" onClick={onRetry} disabled={retrying}>
            {friendly.action}
          </button>
        )}
        <details>
          <summary className="fly-muted" style={{ cursor: 'pointer' }}>
            Technical details
          </summary>
          <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {friendly.technical}
          </pre>
          <button
            className="fly-btn"
            style={{ fontSize: 13, minHeight: 36, padding: '6px 12px' }}
            onClick={() => {
              void navigator.clipboard?.writeText(friendly.technical);
            }}
          >
            Copy error
          </button>
        </details>
      </div>
    </div>
  );
}
