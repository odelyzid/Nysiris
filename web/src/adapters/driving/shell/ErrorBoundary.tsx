/**
 * Crash containment and recovery.
 *
 * `ErrorBoundary` catches render/lifecycle throws so a bad document or a
 * component bug shows a recoverable screen instead of a blank page.
 * `GlobalErrorBanner` catches async errors React cannot see (mixnet promises,
 * event handlers) and offers a reload/reset path without hiding the app.
 */
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { clearAppShellCaches, unregisterServiceWorkers } from '../../../pwa';

interface BoundaryProps {
  children: ReactNode;
}

interface BoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the technical detail available without filling the UI with a stack.
    console.error('nysiris crashed while rendering', error, info.componentStack);
  }

  private recover = () => {
    this.setState({ error: null });
  };

  private restart = async () => {
    await unregisterServiceWorkers();
    await clearAppShellCaches();
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fly-crash" role="alert">
        <section className="fly-card">
          <h2>Something went wrong</h2>
          <p className="fly-muted">
            The app caught a rendering error, so your tabs are still safe. Try recovering first; restarting clears only
            the offline app-shell cache.
          </p>
          <pre className="fly-crash-detail">{this.state.error.message}</pre>
          <div className="fly-row fly-mt-2">
            <button className="fly-btn fly-btn-primary" onClick={this.recover}>
              Recover
            </button>
            <button className="fly-btn" onClick={() => void this.restart()}>
              Restart cleanly
            </button>
          </div>
        </section>
      </main>
    );
  }
}

export function GlobalErrorBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      setMessage(event.error instanceof Error ? event.error.message : event.message || 'Unexpected error');
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      if (reason && typeof reason === 'object' && (reason as { name?: unknown }).name === 'AbortError') return;
      setMessage(reason instanceof Error ? reason.message : String(reason ?? 'Unhandled promise rejection'));
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  if (!message) return null;
  return (
    <div className="fly-crash-banner" role="alert">
      <span>
        <strong>Recovered from an error:</strong> {message}
      </span>
      <span className="fly-row">
        <button className="fly-btn fly-btn-sm" onClick={() => setMessage(null)}>
          Dismiss
        </button>
        <button className="fly-btn fly-btn-sm" onClick={() => window.location.reload()}>
          Reload
        </button>
      </span>
    </div>
  );
}
