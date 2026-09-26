/**
 * First-run onboarding: Welcome → one-click "Connect privately" →
 * automatic best setup → success state. No gateway/topology details;
 * those live under Settings → Advanced.
 */
export function Onboarding({
  step,
  busy,
  error,
  onConnect,
  onDismiss,
}: {
  step: 'welcome' | 'connecting' | 'done';
  busy: boolean;
  error: unknown;
  onConnect: () => void;
  onDismiss: () => void;
}) {
  if (step === 'done') return null;
  return (
    <section className="panel" aria-label="Getting started">
      <h2 className="section-title">Welcome to Nysiris</h2>
      <p>Browse and chat privately. One tap connects you over the private network.</p>
      <p className="fly-muted" style={{ margin: '0 0 4px' }} role="note">
        ⚠️ Experimental software — pre-audit. No independent security audit yet; don't rely on
        this for high-stakes anonymity.
      </p>
      <div className="fly-steps" aria-hidden={step !== 'welcome'}>
        <span>1 · Welcome — nothing to set up yet.</span>
        <span>2 · Connect privately — we pick the fastest safe path for you.</span>
        <span>3 · You are protected — open a private link or say hello.</span>
      </div>
      {step === 'welcome' && (
        <div className="fly-row">
          <button className="btn-primary" onClick={onConnect} disabled={busy}>
            Connect privately
          </button>
          <button className="btn-ghost" onClick={onDismiss}>
            Look around first
          </button>
        </div>
      )}
      {step === 'connecting' && (
        <p role="status">Connecting… finding the fastest private path. This usually takes a few seconds.</p>
      )}
      {error !== null && error !== undefined && (
        <p className="fly-muted">
          If connecting keeps failing, you can still look around — your work is saved on this device.
        </p>
      )}
    </section>
  );
}
