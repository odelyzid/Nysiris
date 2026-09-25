// Run with: node --test web/test
// QR scanning degrades cleanly where BarcodeDetector is absent (node,
// Firefox, Safari): support flag is false and decode rejects with a human
// message instead of throwing platform errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isQrScanSupported, scanQrImage } from '../src/shared/qrScan.ts';

test('scan support is honestly reported', () => {
  assert.equal(isQrScanSupported(), false);
});

test('decode without platform support rejects with guidance', async () => {
  await assert.rejects(() => scanQrImage(undefined), /Chrome or Edge/);
});
