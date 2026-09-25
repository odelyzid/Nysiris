import { useState } from 'react';
import { copyText, displayLabel, shortenAddress, toPrivateLink } from '../../../shared/share';
import { useQrCode } from './useQrCode';

/**
 * Everyday sharing card: petname-first label, Copy link, local QR,
 * and the full address behind "Show technical details".
 *
 * QR generation is fully local (`qrcode` → data URL): the private link
 * never leaves the device to render it.
 */
export function ShareCard({
  address,
  petname,
  linkLabel = 'Private link',
}: {
  address: string;
  petname?: string | null;
  linkLabel?: string;
}) {
  const [showTechnical, setShowTechnical] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);

  const link = toPrivateLink(address);
  const label = displayLabel(address, petname);

  const { url: qrUrl, error: qrError } = useQrCode(showQr, link);

  if (!address) return null;

  const onCopy = async () => {
    const ok = await copyText(link);
    setCopied(ok);
    if (!ok) {
      // Fallback: select the visible technical value for manual copy.
      setShowTechnical(true);
    }
  };

  return (
    <div className="fly-card" aria-label={linkLabel}>
      <div className="fly-row" style={{ justifyContent: 'space-between' }}>
        <strong style={{ fontSize: 16 }}>{label}</strong>
        {petname && (
          <span className="fly-muted" title="Short address">
            {shortenAddress(address)}
          </span>
        )}
      </div>
      <div className="fly-row" style={{ marginTop: 12 }}>
        <button className="fly-btn" onClick={() => void onCopy()}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <button className="fly-btn" onClick={() => setShowQr((v) => !v)} aria-expanded={showQr}>
          {showQr ? 'Hide QR' : 'Show QR'}
        </button>
        <button className="fly-btn" onClick={() => setShowTechnical((v) => !v)} aria-expanded={showTechnical}>
          {showTechnical ? 'Hide technical details' : 'Show technical details'}
        </button>
      </div>
      {showQr && (
        <div style={{ marginTop: 12 }}>
          {qrUrl ? (
            <img className="fly-qr" src={qrUrl} alt={`QR code for ${label}`} width={220} height={220} />
          ) : (
            <p className="fly-muted" role="status">
              {qrError ? `QR failed: ${qrError}` : 'Making your QR code…'}
            </p>
          )}
          <p className="fly-muted">Scan to open this private link. The code is made on this device.</p>
        </div>
      )}
      {showTechnical && (
        <pre
          style={{
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            marginTop: 12,
            marginBottom: 0,
          }}
        >
          {link}
        </pre>
      )}
    </div>
  );
}
