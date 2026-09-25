import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './adapters/driving/shell/App';
import { installLeakGuard } from './mixnet/leakGuard';
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
    <App />
  </React.StrictMode>,
);
