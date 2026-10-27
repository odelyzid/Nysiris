/**
 * Browser chrome: tab strip, back/forward/reload/stop, unified address bar.
 *
 * Presentational only. The document model and all I/O live in
 * `application/browser.ts` + `App.tsx`, so this component is easy to test and
 * reuse on desktop and narrow mobile layouts.
 */
import type { BrowserTab } from '../../../application/browser';
import { tabTitle } from '../../../application/browser';

export interface BrowserChromeProps {
  tabs: BrowserTab[];
  activeTabId: string;
  canBack: boolean;
  canForward: boolean;
  loading: boolean;
  error?: string | null;
  uri: string;
  onUriChange: (value: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onNewTab: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}

export function BrowserChrome({
  tabs,
  activeTabId,
  canBack,
  canForward,
  loading,
  error,
  uri,
  onUriChange,
  onSubmit,
  onBack,
  onForward,
  onReload,
  onStop,
  onNewTab,
  onSelectTab,
  onCloseTab,
}: BrowserChromeProps) {
  return (
    <section className="fly-browserbar" aria-label="Browser">
      <div className="fly-tabstrip" role="tablist" aria-label="Open tabs">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div key={tab.id} className="fly-tab" data-active={active || undefined}>
              <button
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={active}
                aria-controls="fly-page"
                className="fly-tab-select"
                title={tab.error ? `${tab.url || 'New tab'} — ${tab.error}` : tab.url || 'New tab'}
                onClick={() => onSelectTab(tab.id)}
              >
                {tab.loading && <span className="fly-tab-spinner" aria-hidden="true" />}
                {tab.error && (
                  <span className="fly-tab-error" aria-hidden="true">
                    !
                  </span>
                )}
                <span className="fly-tab-label">{tabTitle(tab)}</span>
              </button>
              <button
                type="button"
                className="fly-tab-close"
                aria-label={`Close ${tabTitle(tab)}`}
                title="Close tab"
                onClick={() => onCloseTab(tab.id)}
              >
                ×
              </button>
            </div>
          );
        })}
        <button type="button" className="fly-tab-new" aria-label="New tab" title="New tab" onClick={onNewTab}>
          +
        </button>
      </div>

      <div className="fly-navrow">
        <button
          type="button"
          className="fly-navbtn"
          aria-label="Back"
          title="Back"
          disabled={!canBack}
          onClick={onBack}
        >
          ‹
        </button>
        <button
          type="button"
          className="fly-navbtn"
          aria-label="Forward"
          title="Forward"
          disabled={!canForward}
          onClick={onForward}
        >
          ›
        </button>
        <button
          type="button"
          className="fly-navbtn"
          aria-label={loading ? 'Stop loading' : 'Reload'}
          title={loading ? 'Stop loading' : 'Reload'}
          onClick={loading ? onStop : onReload}
        >
          {loading ? '×' : '⟳'}
        </button>
        <input
          className="fly-input fly-address"
          placeholder="nym:// address or https:// URL"
          value={uri}
          onChange={(event) => onUriChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSubmit();
            }
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Address"
        />
        <button type="button" className="fly-btn fly-btn-primary fly-go" onClick={onSubmit} disabled={!uri.trim()}>
          Open
        </button>
      </div>
      {error && (
        <p className="fly-nav-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
