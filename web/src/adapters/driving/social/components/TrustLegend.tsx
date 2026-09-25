import { STANDING_META } from '../../../../domain/trust';

/** Colour-dot legend for trust standings, shown above the timeline. */
export function TrustLegend() {
  return (
    <div className="fly-trust-legend" aria-label="Trust legend">
      {(Object.keys(STANDING_META) as (keyof typeof STANDING_META)[])
        .filter((s) => s !== 'unknown')
        .map((s) => (
          <span key={s} title={STANDING_META[s].blurb}>
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: STANDING_META[s].color,
                marginRight: 4,
              }}
            />
            {STANDING_META[s].label}
          </span>
        ))}
      <span title="Your explicit call always wins over what was observed"> — your call wins</span>
    </div>
  );
}
