// Run with: node --test web/test
// Zoom steps, clamping, persistence, labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEPS,
  clampZoom,
  loadZoom,
  nextZoom,
  saveZoom,
  zoomLabel,
} from '../src/application/zoom.ts';

function memoryStorage() {
  let raw = null;
  return {
    getItem: () => raw,
    setItem: (_key, value) => {
      raw = value;
    },
  };
}

test('clamps zoom to the supported range and ignores garbage', () => {
  assert.equal(clampZoom(1.234), 1.23);
  assert.equal(clampZoom(0.1), MIN_ZOOM);
  assert.equal(clampZoom(9), MAX_ZOOM);
  assert.equal(clampZoom('nope'), DEFAULT_ZOOM);
  assert.equal(clampZoom(Number.NaN), DEFAULT_ZOOM);
});

test('nextZoom walks the step list and stops at the ends', () => {
  assert.equal(nextZoom(1, 1), 1.1);
  assert.equal(nextZoom(1, -1), 0.9);
  assert.equal(nextZoom(MIN_ZOOM, -1), MIN_ZOOM);
  assert.equal(nextZoom(MAX_ZOOM, 1), MAX_ZOOM);
  assert.deepEqual(
    ZOOM_STEPS.map((step) => step),
    [...ZOOM_STEPS].sort((a, b) => a - b),
  );
});

test('zoom labels round and persistence restores the value', () => {
  assert.equal(zoomLabel(1), '100%');
  assert.equal(zoomLabel(1.256), '126%');
  const storage = memoryStorage();
  assert.equal(loadZoom(storage), DEFAULT_ZOOM);
  saveZoom(storage, 1.5);
  assert.equal(loadZoom(storage), 1.5);
  saveZoom(storage, 99);
  assert.equal(loadZoom(storage), MAX_ZOOM);
  assert.equal(loadZoom(null), DEFAULT_ZOOM);
});
