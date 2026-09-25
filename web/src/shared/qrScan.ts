/**
 * QR scanning via the built-in `BarcodeDetector` (Chrome/Edge on desktop and
 * Android): no dependency, nothing uploaded. Image-file path only — live
 * camera streaming is left to the OS camera app; users photograph and pick.
 *
 * Where QRs come from here: identity QRs (`Social`, `ShareCard`) encode a
 * 64-hex ID; invite links are plain-text URLs. Both decode to text that the
 * caller validates. Secret keys are never rendered as QR codes.
 */

interface DetectorHit {
  rawValue?: string;
}

type DetectorCtor = new (opts?: Record<string, unknown>) => {
  detect(image: ImageBitmap): Promise<DetectorHit[]>;
};

function ctor(): DetectorCtor | null {
  try {
    const BD = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    return typeof BD === 'function' ? BD : null;
  } catch {
    return null;
  }
}

/** False on Firefox/Safari (no `BarcodeDetector`): callers hide the button. */
export function isQrScanSupported(): boolean {
  return ctor() !== null;
}

/** Decode the first QR code in an image. Throws with a human message. */
export async function scanQrImage(image: ImageBitmap): Promise<string> {
  const BD = ctor();
  if (!BD) {
    throw new Error('QR scanning needs Chrome or Edge — type or paste the value instead');
  }
  const hits = await new BD({ formats: ['qr_code'] }).detect(image);
  if (!hits || hits.length === 0) throw new Error('no QR code found in that image');
  const value = hits[0]?.rawValue;
  if (!value) throw new Error('that QR code has no readable text');
  return value;
}
