/**
 * Secondary browser controls: find, zoom, print, permissions, offline state.
 * Presentational; all state transitions live in `App.tsx`.
 */
import { zoomLabel } from '../../../application/zoom';

export interface BrowserToolsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  findOpen: boolean;
  findQuery: string;
  findCount: number;
  findIndex: number;
  onFindToggle: () => void;
  onFindQuery: (value: string) => void;
  onFindNext: () => void;
  onFindPrev: () => void;
  onFindClose: () => void;
  onPrint: () => void;
  printDisabled: boolean;
  permissionsOpen: boolean;
  onPermissionsToggle: () => void;
  offline: boolean;
  swControlled: boolean;
}

export function BrowserTools({
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  findOpen,
  findQuery,
  findCount,
  findIndex,
  onFindToggle,
  onFindQuery,
  onFindNext,
  onFindPrev,
  onFindClose,
  onPrint,
  printDisabled,
  permissionsOpen,
  onPermissionsToggle,
  offline,
  swControlled,
}: BrowserToolsProps) {
  return (
    <div className="fly-toolwrap">
      <div className="fly-toolrow" aria-label="Page tools">
        <button
          type="button"
          className="fly-btn fly-btn-sm"
          aria-pressed={findOpen}
          onClick={onFindToggle}
          title="Find in page (Ctrl/Cmd+F)"
        >
          Find
        </button>
        <span className="fly-zoombar" aria-label="Zoom">
          <button type="button" className="fly-btn fly-btn-sm" onClick={onZoomOut} title="Zoom out (Ctrl/Cmd+-)">
            −
          </button>
          <button type="button" className="fly-btn fly-btn-sm fly-zoom-value" onClick={onZoomReset} title="Reset zoom">
            {zoomLabel(zoom)}
          </button>
          <button type="button" className="fly-btn fly-btn-sm" onClick={onZoomIn} title="Zoom in (Ctrl/Cmd++)">
            +
          </button>
        </span>
        <button
          type="button"
          className="fly-btn fly-btn-sm"
          onClick={onPrint}
          disabled={printDisabled}
          title="Print the active document"
        >
          Print
        </button>
        <button
          type="button"
          className="fly-btn fly-btn-sm"
          aria-pressed={permissionsOpen}
          onClick={onPermissionsToggle}
          title="Permissions for this site"
        >
          Permissions
        </button>
        <span className="fly-tool-status" role="status">
          {offline ? 'Offline · cached shell' : swControlled ? 'Offline cache ready' : 'Online'}
        </span>
      </div>
      {findOpen && (
        <div className="fly-findbar" role="search" aria-label="Find in page">
          <input
            className="fly-input fly-find-input"
            value={findQuery}
            onChange={(event) => onFindQuery(event.target.value)}
            placeholder="Find in page"
            aria-label="Find in page"
            spellCheck={false}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (event.shiftKey) onFindPrev();
                else onFindNext();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                onFindClose();
              }
            }}
          />
          <span className="fly-find-count" aria-live="polite">
            {findQuery ? (findCount === 0 ? 'No matches' : `${findIndex + 1} of ${findCount}`) : ''}
          </span>
          <button
            type="button"
            className="fly-btn fly-btn-sm"
            onClick={onFindPrev}
            disabled={findCount === 0}
            title="Previous"
          >
            ↑
          </button>
          <button
            type="button"
            className="fly-btn fly-btn-sm"
            onClick={onFindNext}
            disabled={findCount === 0}
            title="Next"
          >
            ↓
          </button>
          <button type="button" className="fly-btn fly-btn-sm" onClick={onFindClose} title="Close find">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
