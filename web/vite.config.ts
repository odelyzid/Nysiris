import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Nym mix-fetch / sdk-full-fat packages inline their WASM + Web Worker as
// Base64, so no special bundler plugin is required. We only need:
//  - esnext output (top-level await / modern WASM features)
//  - to keep these packages out of esbuild pre-bundling
//  - cross-origin isolation headers in dev, in case the WASM wants
//    SharedArrayBuffer (harmless otherwise)
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'esnext',
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: ['@nymproject/mix-fetch', '@nymproject/mix-tunnel', '@nymproject/sdk-full-fat'],
  },
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
