import { PANEL_META, PANEL_ORDER, type PanelId } from '../../../application/panels';

/**
 * Window menu: one toggle per panel, plus an always-visible connection pill
 * so tunnel state is readable even with every panel closed.
 */
export function Toolbar({
  open,
  onToggle,
  statusLabel,
  statusTone,
}: {
  open: PanelId[];
  onToggle: (id: PanelId) => void;
  statusLabel: string;
  statusTone: string;
}) {
  return (
    <nav
      aria-label="Panels"
      style={{
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        alignItems: 'center',
        padding: '8px 0',
      }}
    >
      {PANEL_ORDER.map((id) => {
        const active = open.includes(id);
        return (
          <button
            key={id}
            className="fly-btn"
            onClick={() => onToggle(id)}
            aria-pressed={active}
            title={active ? `Hide ${PANEL_META[id].title}` : `Show ${PANEL_META[id].title}`}
            style={{
              fontSize: 13,
              fontWeight: active ? 'bold' : 'normal',
            }}
          >
            {PANEL_META[id].title}
          </button>
        );
      })}
      <span style={{ marginLeft: 'auto', fontSize: 13 }} title={statusLabel}>
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: '50%',
            backgroundColor: statusTone,
            marginRight: 6,
            verticalAlign: 'baseline',
          }}
        />
        {statusLabel}
      </span>
    </nav>
  );
}
