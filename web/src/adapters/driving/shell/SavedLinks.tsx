/**
 * Saved links: named bookmarks + starred portal favourites. Presentational —
 * state lives in `App`. Rendered inside the Portal view so it is reachable on
 * Android / narrow screens, where the desktop roster (which pins favourites) is
 * hidden by `theme.css`.
 */
import { shortenAddress } from '../../../shared/share';
import type { Bookmark } from '../../../application/bookmarks';
import { CloseIcon, StarIcon } from '../shared/icons';

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

      <h3 className="section-title">Bookmarks</h3>
      {bookmarks.length === 0 ? (
        <p className="fly-muted">No bookmarks yet — open a private link and save it with a name.</p>
      ) : (
        <ul className="fly-link-list">
          {bookmarks.map((b) => (
            <li key={b.name} className="fly-link-row">
              <button className="fly-link-open" onClick={() => onOpen(b.link)} title={b.link}>
                <span style={{ fontWeight: 600 }}>{b.name}</span>
                <span className="fly-meta" style={{ display: 'block', wordBreak: 'break-all' }}>
                  {shortenAddress(b.link)}
                </span>
              </button>
              <button
                className="btn-ghost fly-icon-btn"
                onClick={() => onRemoveBookmark(b.name)}
                aria-label={`Remove bookmark ${b.name}`}
                title="Remove bookmark"
              >
                <CloseIcon size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="section-title">Favourites</h3>
      {favorites.length === 0 ? (
        <p className="fly-muted">Star a portal to pin it here.</p>
      ) : (
        <ul className="fly-link-list">
          {favorites.map((address) => (
            <li key={address} className="fly-link-row">
              <button className="fly-link-open" onClick={() => onOpen(address)} title={address}>
                <span aria-hidden="true" className="fly-meta">
                  <StarIcon size={14} />
                </span>{' '}
                <span className="fly-meta" style={{ wordBreak: 'break-all' }}>
                  {shortenAddress(address)}
                </span>
              </button>
              <button
                className="btn-ghost fly-icon-btn"
                onClick={() => onRemoveFavorite(address)}
                aria-label={`Remove favourite ${address}`}
                title="Remove favourite"
              >
                <CloseIcon size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
