/**
 * Shop: a PWA marketplace tab for `services/shop` (docs/16-shop.md).
 *
 * Browse signed listings; publish/update/delete your own; reserve stock with
 * a buyer-signed order; accept/decline/fulfil or cancel; talk in the private
 * per-order thread; leave one review per fulfilled order. Prices are integer
 * minor units. Shipping details belong in Messages (the social DM dead-drop),
 * never on this service.
 */
import { useMemo, useState, type FormEvent } from 'react';
import {
  EMPTY_LISTING_FORM,
  useShop,
  type ListingForm,
} from './hooks/useShop';
import { dayLabel, type Listing, type Order } from './model';
import {
  DEFAULT_MESSAGES_PAGE,
  MAX_DESCRIPTION_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_NOTE_BYTES,
  MAX_ORDER_MESSAGES,
  MAX_ORDER_QTY,
  MAX_REVIEW_BYTES,
  MAX_STOCK,
  MAX_TITLE_CHARS,
  ORDER_STATUS,
  orderStatusName,
} from '../../../domain/shop';

function short(hex: string, head = 10): string {
  return hex.length > head + 6 ? `${hex.slice(0, head)}…${hex.slice(-6)}` : hex;
}

function statusLabel(code: number): string {
  const name = orderStatusName(code);
  return name === 'unknown' ? code === 0 ? 'reserved' : 'unknown' : name;
}

function averageLabel(count: number, sum: number): string {
  if (count === 0) return 'no ratings yet';
  return `${(sum / count).toFixed(1)} / 5 (${count})`;
}

export function Shop() {
  const shop = useShop();
  const {
    service,
    serviceInput,
    setServiceInput,
    connect,
    disconnect,
    tab,
    setTab,
    busy,
    health,
    identity,
    identityLoaded,
    browseQuery,
    browse,
    browseNext,
    myListings,
    orders,
    listingMap,
    reviews,
    search,
    refreshBrowse,
    loadMore,
    refreshMyListings,
    loadOrders,
    loadOlderMessages,
    loadReviews,
    placeOrder,
    saveListing,
    deleteListing,
    changeOrderStatus,
    sendOrderMessage,
    reviewOrder,
    formatMinor,
    log,
  } = shop;

  const [form, setForm] = useState<ListingForm>(EMPTY_LISTING_FORM);
  const [editing, setEditing] = useState<Listing | null>(null);
  const [query, setQuery] = useState(browseQuery);
  const [orderTarget, setOrderTarget] = useState<Listing | null>(null);
  const [orderQty, setOrderQty] = useState('1');
  const [orderNote, setOrderNote] = useState('');
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, { rating: number; body: string }>>({});

  const title = useMemo(() => (service ? `Shop · ${short(service, 14)}` : 'Shop'), [service]);
  // Writes wait for identity restoration so a quick click cannot mint a new
  // key over the persisted one.
  const actionBusy = busy || !identityLoaded;

  const onConnect = (event: FormEvent) => {
    event.preventDefault();
    connect(serviceInput);
  };

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    void search(query);
  };

  const resetForm = () => {
    setForm(EMPTY_LISTING_FORM);
    setEditing(null);
  };

  const startEdit = (listing: Listing) => {
    setEditing(listing);
    setForm({
      title: listing.title,
      description: listing.description,
      price: String(listing.price),
      stock: String(listing.stock),
      currency: listing.currency,
    });
    setTab('sell');
  };

  const onSubmitListing = async (event: FormEvent) => {
    event.preventDefault();
    const ok = await saveListing(form, editing);
    if (ok) resetForm();
  };

  const onDelete = (listing: Listing) => {
    if (typeof window !== 'undefined' && !window.confirm(`Delete “${listing.title}”? Existing orders keep resolving.`)) {
      return;
    }
    void deleteListing(listing);
  };

  const onSubmitOrder = async (event: FormEvent) => {
    event.preventDefault();
    if (!orderTarget) return;
    const ok = await placeOrder(orderTarget, orderQty, orderNote);
    if (ok) {
      setOrderTarget(null);
      setOrderQty('1');
      setOrderNote('');
    }
  };

  const ratingDraft = (orderId: string) => reviewDrafts[orderId] ?? { rating: 5, body: '' };
  const setRating = (orderId: string, rating: number) => {
    setReviewDrafts((prev) => ({ ...prev, [orderId]: { ...ratingDraft(orderId), rating } }));
  };
  const setReviewBody = (orderId: string, body: string) => {
    setReviewDrafts((prev) => ({ ...prev, [orderId]: { ...ratingDraft(orderId), body } }));
  };

  const sellerReviews = (seller: string) => reviews[seller.toLowerCase()];

  const renderListing = (listing: Listing, own = false) => {
    const ownListing = own || (identity !== null && listing.seller === identity.pubHex);
    const rv = sellerReviews(listing.seller);
    return (
      <li key={listing.id} className="fly-card fly-mt-2">
        <div className="fly-row fly-row-between">
          <div>
            <strong>{listing.title}</strong>{' '}
            <span className="fly-muted">
              {formatMinor(listing.price, listing.currency)} · {listing.available} available
            </span>
          </div>
          <span className="fly-meta" title={listing.seller}>
            {short(listing.seller, 8)} · v{listing.version} · {dayLabel(listing.day)}
          </span>
        </div>
        {listing.description && <p className="fly-break-word">{listing.description}</p>}
        <div className="fly-row">
          <button
            className="fly-btn fly-btn-primary"
            disabled={actionBusy || ownListing || listing.available < 1}
            onClick={() => {
              setOrderTarget(listing);
              setOrderQty('1');
              setOrderNote('');
            }}
          >
            {ownListing ? 'Your listing' : listing.available < 1 ? 'Out of stock' : 'Order'}
          </button>
          <button className="fly-btn" disabled={busy} onClick={() => void loadReviews(listing.seller)}>
            Reviews
          </button>
          {ownListing && (
            <>
              <button className="fly-btn" disabled={actionBusy} onClick={() => startEdit(listing)}>
                Edit
              </button>
              <button className="fly-btn" disabled={actionBusy} onClick={() => onDelete(listing)}>
                Delete
              </button>
            </>
          )}
        </div>
        {rv && (
          <div className="fly-mt-2">
            <p className="fly-meta">
              Seller reputation: {averageLabel(rv.summary.count, rv.summary.sum)} · raw signed reviews, verified here
            </p>
            {rv.reviews.length === 0 ? (
              <p className="fly-muted">No verified reviews.</p>
            ) : (
              <ul className="fly-list">
                {rv.reviews.map((review) => (
                  <li key={review.order}>
                    <strong>{review.rating}/5</strong> <span className="fly-break-word">{review.body}</span>{' '}
                    <span className="fly-muted">— {short(review.author, 8)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {orderTarget?.id === listing.id && (
          <form className="fly-mt-2" onSubmit={(event) => void onSubmitOrder(event)} aria-label="Reserve this listing">
            <div className="fly-row">
              <label className="fly-muted" htmlFor={`qty-${listing.id}`}>
                Quantity (max {Math.min(MAX_ORDER_QTY, listing.available)})
              </label>
              <input
                id={`qty-${listing.id}`}
                className="fly-input fly-field-sm"
                inputMode="numeric"
                value={orderQty}
                onChange={(event) => setOrderQty(event.target.value)}
              />
              <button className="fly-btn fly-btn-primary" type="submit" disabled={actionBusy}>
                Reserve
              </button>
              <button className="fly-btn" type="button" onClick={() => setOrderTarget(null)}>
                Cancel
              </button>
            </div>
            <input
              className="fly-input fly-mt-2"
              placeholder={`Short public note (optional, max ${MAX_NOTE_BYTES} bytes — no addresses)`}
              value={orderNote}
              onChange={(event) => setOrderNote(event.target.value)}
            />
            <p className="fly-meta">
              The buyer signature reserves stock atomically. The seller accepts or declines; cancel returns the stock.
            </p>
          </form>
        )}
      </li>
    );
  };

  const renderOrder = (order: Order) => {
    const listing = listingMap[order.listing];
    const role = identity ? (identity.pubHex === order.buyer ? 'buyer' : identity.pubHex === order.seller ? 'seller' : null) : null;
    const draft = ratingDraft(order.id);
    const canReview = role === 'buyer' && order.status_code === ORDER_STATUS.fulfilled && !order.review;
    return (
      <li key={order.id} className="fly-card fly-mt-2">
        <div className="fly-row fly-row-between">
          <strong>{listing ? listing.title : `Listing ${short(order.listing)}`}</strong>
          <span className="fly-meta">
            {statusLabel(order.status_code)} · {order.qty} ×{' '}
            {formatMinor(order.price, listing?.currency ?? 'USD')}
          </span>
        </div>
        <p className="fly-meta">
          Order {short(order.id)} · {dayLabel(order.day)} · terms v{order.version} · you are {role ?? 'a reader'} ·
          buyer {short(order.buyer, 8)} · seller {short(order.seller, 8)}
        </p>
        {order.note && <p className="fly-break-word">{order.note}</p>}
        <div className="fly-row">
          {role === 'seller' && order.status_code === ORDER_STATUS.reserved && (
            <>
              <button className="fly-btn fly-btn-primary" disabled={actionBusy} onClick={() => void changeOrderStatus(order, ORDER_STATUS.accepted)}>
                Accept
              </button>
              <button className="fly-btn" disabled={actionBusy} onClick={() => void changeOrderStatus(order, ORDER_STATUS.declined)}>
                Decline
              </button>
            </>
          )}
          {role === 'seller' && order.status_code === ORDER_STATUS.accepted && (
            <button className="fly-btn fly-btn-primary" disabled={actionBusy} onClick={() => void changeOrderStatus(order, ORDER_STATUS.fulfilled)}>
              Mark fulfilled
            </button>
          )}
          {role === 'buyer' && (order.status_code === ORDER_STATUS.reserved || order.status_code === ORDER_STATUS.accepted) && (
            <button className="fly-btn" disabled={actionBusy} onClick={() => void changeOrderStatus(order, ORDER_STATUS.cancelled)}>
              Cancel order
            </button>
          )}
        </div>

        {order.review ? (
          <p className="fly-mt-2">
            <strong>Buyer review: {order.review.rating}/5</strong>{' '}
            <span className="fly-break-word">{order.review.body}</span>
          </p>
        ) : (
          canReview && (
            <form
              className="fly-mt-2"
              onSubmit={(event) => {
                event.preventDefault();
                void reviewOrder(order, draft.rating, draft.body);
              }}
              aria-label="Review this order"
            >
              <div className="fly-row">
                <label className="fly-muted" htmlFor={`rating-${order.id}`}>
                  Rating
                </label>
                <select
                  id={`rating-${order.id}`}
                  className="fly-input fly-field-sm"
                  value={draft.rating}
                  onChange={(event) => setRating(order.id, Number(event.target.value))}
                >
                  {[5, 4, 3, 2, 1].map((n) => (
                    <option key={n} value={n}>
                      {n} / 5
                    </option>
                  ))}
                </select>
                <button className="fly-btn fly-btn-primary" type="submit" disabled={actionBusy}>
                  Post review
                </button>
              </div>
              <input
                className="fly-input fly-mt-2"
                placeholder={`Public review (max ${MAX_REVIEW_BYTES} bytes)`}
                value={draft.body}
                onChange={(event) => setReviewBody(order.id, event.target.value)}
              />
            </form>
          )
        )}

        <details className="fly-mt-2">
          <summary>
            Private thread ({order.messages.length} shown of {order.messages_total})
          </summary>
          <ul className="fly-list">
            {order.messages.map((message, index) => (
              <li key={`${message.author}-${message.day}-${index}`}>
                <span className="fly-muted">{short(message.author, 8)}:</span>{' '}
                <span className="fly-break-word">{message.body}</span>
              </li>
            ))}
            {order.messages.length === 0 && <li className="fly-muted">No messages yet.</li>}
          </ul>
          {order.messages_next_offset !== null && (
            <button
              className="fly-btn fly-mt-2"
              disabled={busy}
              onClick={() => void loadOlderMessages(order)}
            >
              Load older messages ({DEFAULT_MESSAGES_PAGE} older)
            </button>
          )}
          <p className="fly-meta">
            Threads are capped at {MAX_ORDER_MESSAGES} signed messages; newer reads show the latest page.
          </p>
          {(role === 'buyer' || role === 'seller') && (
            <form
              className="fly-row fly-mt-2"
              onSubmit={(event) => {
                event.preventDefault();
                const body = messageDrafts[order.id] ?? '';
                void sendOrderMessage(order, body).then((ok) => {
                  if (ok) setMessageDrafts((prev) => ({ ...prev, [order.id]: '' }));
                });
              }}
            >
              <input
                className="fly-input"
                placeholder={`Message the other party (max ${MAX_MESSAGE_BYTES} bytes — no addresses)`}
                value={messageDrafts[order.id] ?? ''}
                onChange={(event) => setMessageDrafts((prev) => ({ ...prev, [order.id]: event.target.value }))}
              />
              <button className="fly-btn fly-btn-primary" type="submit" disabled={busy || !(messageDrafts[order.id] ?? '').trim()}>
                Send
              </button>
            </form>
          )}
        </details>
      </li>
    );
  };

  return (
    <section className="panel" aria-label="Shop">
      <div className="fly-view-head">
        <h2>{title}</h2>
        <span className="fly-meta">Signed listings, private orders, raw reviews. Prices are integer minor units.</span>
      </div>

      <form className="fly-card" onSubmit={onConnect} aria-label="Marketplace address">
        <h3 className="fly-h3">Marketplace address</h3>
        <p className="fly-muted">
          Paste the shop provider’s Nym address once. Listings are public; your order book is readable only with your
          key. No payments are processed — settle between yourselves.
        </p>
        <div className="fly-row">
          <input
            className="fly-input"
            placeholder="nym://… or id.enc@gw"
            value={serviceInput}
            onChange={(event) => setServiceInput(event.target.value)}
            spellCheck={false}
            aria-label="Shop provider address"
          />
          <button className="fly-btn fly-btn-primary" type="submit" disabled={busy || !serviceInput.trim()}>
            {service ? 'Switch' : 'Connect'}
          </button>
          {service && (
            <button className="fly-btn" type="button" onClick={disconnect} disabled={busy}>
              Forget
            </button>
          )}
        </div>
        {health && (
          <p className="fly-meta">
            {health.listings} active listing(s) · {health.orders} order(s) on this provider
          </p>
        )}
      </form>

      {service && (
        <>
          <nav className="fly-row fly-mt-2" aria-label="Shop sections">
            <button
              className={tab === 'browse' ? 'fly-btn fly-btn-secondary' : 'fly-btn'}
              aria-current={tab === 'browse' ? 'page' : undefined}
              onClick={() => setTab('browse')}
            >
              Browse
            </button>
            <button
              className={tab === 'sell' ? 'fly-btn fly-btn-secondary' : 'fly-btn'}
              aria-current={tab === 'sell' ? 'page' : undefined}
              onClick={() => setTab('sell')}
            >
              Sell
            </button>
            <button
              className={tab === 'orders' ? 'fly-btn fly-btn-secondary' : 'fly-btn'}
              aria-current={tab === 'orders' ? 'page' : undefined}
              onClick={() => setTab('orders')}
            >
              Orders
            </button>
          </nav>

          {tab === 'browse' && (
            <section className="fly-card" aria-label="Browse listings">
              <form className="fly-row" onSubmit={onSearch}>
                <input
                  className="fly-input"
                  placeholder="Search titles and descriptions"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label="Search listings"
                />
                <button className="fly-btn fly-btn-primary" type="submit" disabled={busy}>
                  Search
                </button>
                <button className="fly-btn" type="button" disabled={busy} onClick={() => void refreshBrowse()}>
                  Refresh
                </button>
              </form>
              {browse.length === 0 ? (
                <p className="fly-muted">
                  {busy ? 'Loading listings…' : 'No listings yet. Open Sell to publish the first one.'}
                </p>
              ) : (
                <ul className="fly-plain-list">{browse.map((listing) => renderListing(listing))}</ul>
              )}
              {browseNext !== null && (
                <button className="fly-btn fly-mt-2" disabled={busy} onClick={() => void loadMore()}>
                  Load more
                </button>
              )}
            </section>
          )}

          {tab === 'sell' && (
            <section className="fly-card" aria-label="Sell">
              <h3 className="fly-h3">{editing ? `Update “${editing.title}”` : 'Publish a listing'}</h3>
              <p className="fly-muted">
                {identity
                  ? `Your public key is your shop identity: ${short(identity.pubHex, 16)}`
                  : 'An identity is created and secured on this device when you publish.'}
              </p>
              <form onSubmit={(event) => void onSubmitListing(event)} aria-label="Listing form">
                <input
                  className="fly-input fly-mt-2"
                  placeholder={`Title (max ${MAX_TITLE_CHARS} chars)`}
                  value={form.title}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                  maxLength={MAX_TITLE_CHARS}
                />
                <textarea
                  className="fly-input fly-mt-2"
                  placeholder={`Description (max ${MAX_DESCRIPTION_CHARS} chars)`}
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                  rows={4}
                />
                <div className="fly-row fly-mt-2">
                  <input
                    className="fly-input"
                    placeholder="Price in minor units (e.g. 1234 = 12.34)"
                    inputMode="numeric"
                    value={form.price}
                    onChange={(event) => setForm({ ...form, price: event.target.value })}
                  />
                  <input
                    className="fly-input fly-field-sm"
                    placeholder="Currency"
                    value={form.currency}
                    onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })}
                    maxLength={3}
                  />
                  <input
                    className="fly-input fly-field-sm"
                    placeholder={`Stock (max ${MAX_STOCK})`}
                    inputMode="numeric"
                    value={form.stock}
                    onChange={(event) => setForm({ ...form, stock: event.target.value })}
                  />
                </div>
                <p className="fly-meta">
                  An update re-signs with version {editing ? editing.version + 1 : 1}; a lower version is refused, so an
                  old listing can never roll price or stock back.
                </p>
                <div className="fly-row">
                  <button className="fly-btn fly-btn-primary" type="submit" disabled={actionBusy}>
                    {editing ? 'Update listing' : 'Publish listing'}
                  </button>
                  {editing && (
                    <button className="fly-btn" type="button" onClick={resetForm}>
                      Cancel edit
                    </button>
                  )}
                </div>
              </form>

              <h3 className="fly-h3 fly-mt-3">My listings</h3>
              <div className="fly-row">
                <button className="fly-btn" disabled={busy || !identity} onClick={() => void refreshMyListings()}>
                  Refresh mine
                </button>
              </div>
              {myListings.length === 0 ? (
                <p className="fly-muted">No listings under this identity yet.</p>
              ) : (
                <ul className="fly-plain-list">{myListings.map((listing) => renderListing(listing, true))}</ul>
              )}
            </section>
          )}

          {tab === 'orders' && (
            <section className="fly-card" aria-label="Orders">
              <div className="fly-row fly-row-between">
                <h3 className="fly-h3">Orders</h3>
                <button className="fly-btn" disabled={busy || !identity} onClick={() => void loadOrders()}>
                  Refresh
                </button>
              </div>
              <p className="fly-muted">
                Reads require a signature from your key. Only the buyer and seller see an order. Trade shipping details
                over Messages — never in notes or threads.
              </p>
              {!identity && <p className="fly-callout-warn">Your identity is still loading. Publish a listing or reopen this tab.</p>}
              {orders.length === 0 ? (
                <p className="fly-muted">{busy ? 'Loading orders…' : 'No orders yet.'}</p>
              ) : (
                <ul className="fly-plain-list">{orders.map((order) => renderOrder(order))}</ul>
              )}
            </section>
          )}

          {log.length > 0 && (
            <details className="fly-card fly-mt-2" aria-label="Shop activity">
              <summary>Activity log</summary>
              <pre className="fly-pre fly-meta fly-mt-2">{log.join('\n')}</pre>
            </details>
          )}
        </>
      )}
    </section>
  );
}
