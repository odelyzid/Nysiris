/**
 * "Run a Portal" tab: hosts a portal service *out of the box* from the browser.
 *
 * The browser is only the client — the actual service runs as a separate
 * program (`services/portal-provider`, `scripts/run-provider.sh`). This view
 * generates the portal identity, hands over copyable quick-start commands,
 * remembers simple runtime preferences, and can probe a running provider's
 * address through the existing `fetchNym` tunnel. It never runs the service.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  PORTAL_OS_META,
  PORTAL_OS_ORDER,
  PORTAL_RELEASE_URL,
  advanceProbe,
  detectPortalOs,
  defaultPortalRunStorage,
  formatProbeLatency,
  inviteLinkFor,
  loadPortalRun,
  quickStartCommand,
  renderConfigSnippet,
  savePortalRun,
  type PortalConfig,
  type PortalOs,
  type PortalProbe,
} from '../../../application/runPortal';
import { createPortalIdentity, importPortalIdentity, loadPortalIdentity, type Identity } from '../../../application/identityStore';
import { copyText, shortenAddress } from '../../../shared/share';
import { useQrCode } from '../shared/useQrCode';

export interface RunPortalProps {
  onProbe: (address: string) => Promise<{ ok: boolean; summary: string }>;
  busy: boolean;
}

export function RunPortal({ onProbe, busy }: RunPortalProps) {
  const [identity, setIdentity] = useState<Identity | null>(() => loadPortalIdentity());
  const [prefs, setPrefs] = useState(() => loadPortalRun(defaultPortalRunStorage()));
  const [probe, setProbe] = useState<PortalProbe>('idle');
  const [probeSummary, setProbeSummary] = useState('');
  const [probeMs, setProbeMs] = useState<number | null>(null);
  const [importKey, setImportKey] = useState('');
  const [copied, setCopied] = useState('');
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    if (prefs.os === null) {
      const detected = detectPortalOs(typeof navigator !== 'undefined' ? navigator.userAgent : '');
      if (detected) setPrefs((p) => ({ ...p, os: detected }));
    }
  }, [prefs.os]);

  useEffect(() => {
    savePortalRun(prefs, defaultPortalRunStorage());
  }, [prefs]);

  const invite = useMemo(() => inviteLinkFor(prefs.providerAddress), [prefs.providerAddress]);

  // Local QR for the invite link: generated on this device, never uploaded.
  const { url: qrUrl } = useQrCode(showQr, invite);

  const onCopy = (label: string, text: string) => {
    void copyText(text).then((ok) => setCopied(ok ? label : ''));
  };

  const onGenerateIdentity = () => {
    const id = createPortalIdentity();
    setIdentity(id);
    setCopied('');
  };

  const onImportIdentity = () => {
    try {
      const id = importPortalIdentity(importKey);
      setIdentity(id);
      setImportKey('');
      setCopied('');
    } catch (err) {
      setProbeSummary(`identity import failed: ${String(err)}`);
    }
  };

  const onTestAddress = async () => {
    if (!prefs.providerAddress.trim() || busy) return;
    setProbe('checking');
    setProbeSummary('');
    setProbeMs(null);
    const started = Date.now();
    const res = await onProbe(prefs.providerAddress.trim());
    const elapsed = Date.now() - started;
    setProbe(advanceProbe('checking', res.ok));
    setProbeSummary(res.summary);
    if (res.ok) setProbeMs(elapsed);
  };

  const updateConfig = (patch: Partial<PortalConfig>) => {
    setPrefs((p) => ({ ...p, config: { ...p.config, ...patch } }));
  };

  const selectedOs = prefs.os;

  return (
    <main>
      <section className="fly-card" aria-label="Run a Portal">
        <h2>Run a Portal</h2>
        <p>
          A Portal is a private site others can visit over the mixnet. The browser is only the client — the actual
          service runs as a small program on a computer or server.
        </p>
      </section>

      <section className="fly-card" aria-label="Quick start">
        <h2>Quick start</h2>
        <p>Pick your setup, then start the provider. It prints its Nym address on startup.</p>
        <div role="tablist" aria-label="Platform" className="fly-tabbar">
          {PORTAL_OS_ORDER.map((os) => (
            <button
              key={os}
              role="tab"
              aria-selected={prefs.os === os}
              title={PORTAL_OS_META[os].blurb}
              onClick={() => setPrefs((p) => ({ ...p, os }))}
              className="fly-tab"
            >
              {PORTAL_OS_META[os].title}
            </button>
          ))}
        </div>
        {selectedOs !== null && (
          <div role="tabpanel" aria-label={PORTAL_OS_META[selectedOs].title}>
            <pre className="fly-code" style={{ maxHeight: 260 }}>
              {quickStartCommand(selectedOs)}
            </pre>
            <button
              className="fly-btn fly-btn-secondary"
              onClick={() => onCopy('quick-start', quickStartCommand(selectedOs))}
            >
              {copied === 'quick-start' ? 'Copied' : 'Copy command'}
            </button>{' '}
            <a
              className="fly-btn"
              href={PORTAL_RELEASE_URL}
              target="_blank"
              rel="noreferrer"
              title="CI-published release assets (launcher zip, .deb, Android)"
            >
              Latest release assets (GitHub)
            </a>
          </div>
        )}
        <p className="fly-muted">
          The simplest host is the <code>nysiris</code> CLI (<code>./build.sh services nysiris-cli</code>):{' '}
          <code>nysiris host echo</code> or <code>nysiris host files --web-root ./public</code>. The release zip (from{' '}
          <code>./build.sh windows</code>) ships the launcher and PWA; the portal provider binary is built from source
          with <code>./build.sh services portal-provider</code>. See <code>docs/13-sdk-cli.md</code> and{' '}
          <code>docs/04-hosting-services.md</code> for the full story.
        </p>
      </section>

      <section className="fly-card" aria-label="Portal identity">
        <h2>Portal identity</h2>
        <p>
          A separate keypair from your social identity. The running provider derives its full <code>nym://</code>{' '}
          address from its client keys — this identity is the one you control directly, so you can re-publish from the
          same address.
        </p>
        {identity ? (
          <div className="fly-identity-bar">
            <span className="fly-identity-id" title={identity.pubHex}>
              ID {identity.pubHex.slice(0, 12)}…
            </span>
            <button className="fly-btn fly-btn-secondary" onClick={() => onCopy('identity', identity.pubHex)}>
              {copied === 'identity' ? 'Copied' : 'Copy public key'}
            </button>
            <button className="fly-btn" onClick={onGenerateIdentity}>
              New keypair
            </button>
          </div>
        ) : (
          <div className="fly-row">
            <button className="fly-btn fly-btn-primary" onClick={onGenerateIdentity}>
              Generate a portal identity
            </button>
          </div>
        )}
        <div className="fly-row">
          <input
            className="fly-input"
            placeholder="Import a private key (64 hex chars)"
            value={importKey}
            onChange={(e) => setImportKey(e.target.value)}
            spellCheck={false}
            aria-label="Import portal identity"
          />
          <button className="fly-btn" onClick={onImportIdentity} disabled={!importKey.trim()}>
            Import
          </button>
        </div>

        <label className="fly-muted" style={{ display: 'block', marginTop: 12 }}>
          Provider address (from <code>nym-address.txt</code>, or paste the link you share):
        </label>
        <div className="fly-row">
          <input
            className="fly-input"
            placeholder="id.enc@gw"
            value={prefs.providerAddress}
            onChange={(e) => setPrefs((p) => ({ ...p, providerAddress: e.target.value }))}
            spellCheck={false}
            aria-label="Provider address"
          />
          <button className="fly-btn fly-btn-secondary" onClick={() => onCopy('invite', invite)} disabled={!invite}>
            {copied === 'invite' ? 'Copied' : 'Copy invite link'}
          </button>
          <button
            className="fly-btn fly-btn-ghost"
            aria-pressed={showQr}
            onClick={() => setShowQr((v) => !v)}
            disabled={!invite}
          >
            QR
          </button>
        </div>
        {invite && (
          <p className="fly-muted" style={{ wordBreak: 'break-all', fontSize: 12 }}>
            {invite}
          </p>
        )}
        {showQr && qrUrl && <img src={qrUrl} alt={`QR invite ${shortenAddress(invite)}`} width={220} height={220} />}
      </section>

      <section className="fly-card" aria-label="Status">
        <h2>Status</h2>
        <p>No local provider detected by default — paste the provider address above, then test it.</p>
        <div className="fly-row">
          <button
            className="fly-btn"
            onClick={() => void onTestAddress()}
            disabled={!prefs.providerAddress.trim() || busy}
          >
            {probe === 'checking' ? 'Testing…' : 'Test this portal address'}
          </button>
          {probe !== 'idle' && (
            <span>
              {probe === 'reachable'
                ? `Provider reachable · ${probeMs !== null ? formatProbeLatency(probeMs) : ''}`.trim()
                : probe === 'unreachable'
                  ? 'Not reachable'
                  : 'Idle'}
            </span>
          )}
        </div>
        {probeSummary && (
          <p className="fly-muted" style={{ fontSize: 12 }}>
            {probeSummary}
          </p>
        )}
      </section>

      <section className="fly-card" aria-label="Advanced configuration">
        <details>
          <summary>Advanced / Configuration</summary>
          <p className="fly-muted">These only render the environment the provider honors — nothing runs here.</p>
          <div className="fly-row">
            <label>
              PoW bits{' '}
              <input
                className="fly-input"
                type="number"
                min={0}
                max={32}
                value={prefs.config.powBits}
                onChange={(e) => updateConfig({ powBits: Number(e.target.value) })}
                aria-label="PoW bits"
                style={{ width: 76 }}
              />
            </label>
            <label>
              Rate/day{' '}
              <input
                className="fly-input"
                type="number"
                min={0}
                value={prefs.config.ratePerDay}
                onChange={(e) => updateConfig({ ratePerDay: Number(e.target.value) })}
                aria-label="Entries per day"
                style={{ width: 96 }}
              />
            </label>
            <label>
              Data dir{' '}
              <input
                className="fly-input"
                value={prefs.config.dataDir}
                onChange={(e) => updateConfig({ dataDir: e.target.value })}
                aria-label="Data directory"
                style={{ width: 160 }}
              />
            </label>
          </div>
          <pre className="fly-code">{renderConfigSnippet(prefs.config, prefs.os)}</pre>
          <button className="fly-btn fly-btn-secondary" onClick={() => onCopy('config', renderConfigSnippet(prefs.config))}>
            {copied === 'config' ? 'Copied' : 'Copy config'}
          </button>
        </details>
      </section>

      <section className="fly-card" aria-label="Help and docs">
        <h2>Help / Docs</h2>
        <p className="fly-muted">
          <code>docs/13-sdk-cli.md</code> — hosting SDK and the <code>nysiris</code> CLI
          <br />
          <code>docs/04-hosting-services.md</code> — hosting a service
          <br />
          <code>docs/08-hidden-services.md</code> — nym:// envelopes and dispatch
          <br />
          <code>docs/10-portal.md</code> — object + log replication design
          <br />
          <code>scripts/run-provider.sh</code> — defaults and knobs
        </p>
      </section>
    </main>
  );
}
