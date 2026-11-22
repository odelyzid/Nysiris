import type { TunnelStateView } from '../../../mixnet/tunnel';
import { NAV_VIEW_ORDER, VIEW_META, type ViewId } from '../../../application/views';
import { StatusPill } from '../shared/StatusPill';

/**
 * Primary navigation: Home / Messages / Service / Settings + the discreet
 * protection pill. Pages open from the address bar and portals from the
 * roster, so neither gets a redundant top tab.
 */
export function AppNav({
  active,
  onSelect,
  status,
  statusDetail,
  onRetry,
  busy,
}: {
  active: ViewId;
  onSelect: (view: ViewId) => void;
  status: TunnelStateView;
  statusDetail?: string;
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <nav aria-label="Primary" className="fly-nav">
      {NAV_VIEW_ORDER.map((id) => (
        <button
          key={id}
          className="fly-nav-btn"
          aria-current={active === id ? 'page' : undefined}
          title={VIEW_META[id].blurb}
          onClick={() => onSelect(id)}
        >
          {VIEW_META[id].title}
        </button>
      ))}
      <StatusPill status={status} detail={statusDetail} onRetry={onRetry} busy={busy} />
    </nav>
  );
}
