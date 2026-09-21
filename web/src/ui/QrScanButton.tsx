import { useRef, useState } from 'react';
import { isQrScanSupported, scanQrImage } from './qrScan';

/**
 * "Scan QR" button: picks an image file, decodes the first QR code in it,
 * hands the text to the caller for validation. Renders nothing where
 * `BarcodeDetector` is unavailable (Firefox/Safari) — the text field next
 * to it stays the way in.
 */
export function QrScanButton({
  onScanText,
  onScanError,
  label = 'Scan QR',
}: {
  onScanText: (text: string) => void;
  onScanError: (message: string) => void;
  label?: string;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [scanning, setScanning] = useState(false);
  if (!isQrScanSupported()) return null;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setScanning(true);
    try {
      const bmp = await createImageBitmap(file);
      try {
        onScanText((await scanQrImage(bmp)).trim());
      } finally {
        bmp.close();
      }
    } catch (err) {
      onScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
        }}
      />
      <button
        className="fly-btn"
        style={{ fontSize: 12 }}
        disabled={scanning}
        title="Read a QR code from an image file"
        onClick={() => fileRef.current?.click()}
      >
        {scanning ? 'Scanning…' : label}
      </button>
    </>
  );
}
