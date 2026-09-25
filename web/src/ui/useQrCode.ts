/**
 * Local QR data-URL generation from the `qrcode` module. Imported lazily so
 * the PWA shell stays fast; generation is fully local — the encoded text
 * never leaves the device. Shared by the ID card, ShareCard, and RunPortal.
 */
import { useEffect, useState } from 'react';

export interface QrResult {
  url: string | null;
  error: string | null;
}

export function useQrCode(enabled: boolean, text: string | null | undefined): QrResult {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !text) {
      setUrl(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setUrl(null);
    setError(null);
    import('qrcode')
      .then((m) => m.toDataURL(text, { margin: 1, width: 220 }))
      .then(
        (u) => {
          if (!cancelled) setUrl(u);
        },
        (err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [enabled, text]);

  return { url, error };
}
