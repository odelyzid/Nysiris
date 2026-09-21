import type { TunnelStateView } from '../mixnet/tunnel';
import { VIEW_ORDER, VIEW_META, type ViewId } from './views';
import { StatusPill } from './StatusPill';

/**
 * Primary navigation: Home / Messages / Portal / Settings + the
 * discreet protection pill. Mobile-friendly top bar; the main area
 * below stays focused on one view at a time.
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
      {VIEW_ORDER.map((id) => (
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
