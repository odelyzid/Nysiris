import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './adapters/driving/shell/App';
import { ErrorBoundary, GlobalErrorBanner } from './adapters/driving/shell/ErrorBoundary';
import { installLeakGuard } from './mixnet/leakGuard';
import { registerServiceWorker } from './pwa';
import './adapters/driving/shared/theme.css';

// Hosts that must never be reached directly. In a real app these are the
// services you route through the mixnet. Fail closed in development only.
const ROUTED_HOSTS = new Set<string>(['example.com', 'api.example.com']);

installLeakGuard(ROUTED_HOSTS, import.meta.env.DEV);

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root missing');
}
createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <GlobalErrorBanner />
  </React.StrictMode>,
);

// Vite's dev server already hot-reloads assets; a service worker there would
// serve stale modules and make HMR confusing. Production builds cache the
// app shell for offline start-up.
if (import.meta.env.PROD) {
  void registerServiceWorker({
    onUpdate: () => console.info('nysiris: a new offline shell is ready'),
  });
}
