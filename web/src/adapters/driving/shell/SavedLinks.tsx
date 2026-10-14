/**
 * Saved links: named bookmarks + starred portal favourites. Presentational —
 * state lives in `App`. Rendered inside the Portal view so it is reachable on
 * Android / narrow screens, where the desktop roster (which pins favourites) is
 * hidden by `theme.css`.
 */
import type { CSSProperties } from 'react';
import { shortenAddress } from '../../../shared/share';
import type { Bookmark } from '../../../application/bookmarks';

const LIST: CSSProperties = { listStyle: 'none', padding: 0, margin: '4px 0 14px', display: 'grid', gap: 6 };
const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  border: '1px solid var(--fly-line)',
  padding: '6px 10px',
};
const OPEN: CSSProperties = {
  flex: 1,
  textAlign: 'left',
  background: 'transparent',
  border: 0,
  color: 'inherit',
  cursor: 'pointer',
  overflow: 'hidden',
};

export function SavedLinks({
  bookmarks,
  favorites,
  onOpen,
  onRemoveBookmark,
  onRemoveFavorite,
}: {
  bookmarks: Bookmark[];
  favorites: string[];
  onOpen: (link: string) => void;
  onRemoveBookmark: (name: string) => void;
  onRemoveFavorite: (address: string) => void;
}) {
  return (
    <section className="fly-card" aria-label="Saved links">
      <h2>Saved</h2>
      <p className="fly-muted">Bookmarks and favourites stay on this device.</p>

      <h3>Bookmarks</h3>
      {bookmarks.length === 0 ? (
        <p className="fly-muted">No bookmarks yet — open a private link and save it with a name.</p>
      ) : (
        <ul style={LIST}>
          {bookmarks.map((b) => (
            <li key={b.name} style={ROW}>
              <button style={OPEN} onClick={() => onOpen(b.link)} title={b.link}>
                <span style={{ fontWeight: 600 }}>{b.name}</span>
                <span className="fly-sub" style={{ display: 'block', wordBreak: 'break-all' }}>
                  {shortenAddress(b.link)}
                </span>
              </button>
              <button
                className="btn-ghost"
                onClick={() => onRemoveBookmark(b.name)}
                aria-label={`Remove bookmark ${b.name}`}
                title="Remove bookmark"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>Favourites</h3>
      {favorites.length === 0 ? (
        <p className="fly-muted">Star a portal to pin it here.</p>
      ) : (
        <ul style={LIST}>
          {favorites.map((address) => (
            <li key={address} style={ROW}>
              <button style={OPEN} onClick={() => onOpen(address)} title={address}>
                <span aria-hidden="true">★ </span>
                <span className="fly-sub" style={{ wordBreak: 'break-all' }}>
                  {shortenAddress(address)}
                </span>
              </button>
              <button
                className="btn-ghost"
                onClick={() => onRemoveFavorite(address)}
                aria-label={`Remove favourite ${address}`}
                title="Remove favourite"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
