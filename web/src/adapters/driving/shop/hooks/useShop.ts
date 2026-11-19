/**
 * Shop state + actions. Talks to a `services/shop` provider exclusively
 * through `fetchNym` (the shared, serialized client). Every listing, order,
 * status change, thread message, and review is signed locally before it is
 * sent, and every row read back is re-verified before it is rendered — the
 * provider is a relay and a store, not an authority (docs/16-shop.md).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { splitNymUri } from '../../../../mixnet/hiddenService.mjs';
import { saveShopService, loadShopService } from '../../../../application/shopStore';
import {
  DEFAULT_LISTINGS_PAGE,
  DEFAULT_MESSAGES_PAGE,
  MAX_DESCRIPTION_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_NOTE_BYTES,
  MAX_ORDER_QTY,
  MAX_REVIEW_BYTES,
  MAX_STOCK,
  MAX_TITLE_CHARS,
  canTransition,
  currentDay,
  formatMinor,
  isCurrencyCode,
  isValidRating,
  listingDeletePowPreimage,
  listingPowPreimage,
  newIdHex,
  orderMessagePowPreimage,
  orderPowPreimage,
  orderStatusName,
  orderStatusPowPreimage,
  parseUint,
  reviewPowPreimage,
  signListing,
  signListingDelete,
  signOrder,
  signOrderMessage,
  signOrderStatus,
  signOrdersRead,
  signReview,
  summarizeRatings,
  verifyListingSignature,
  verifyOrderMessageSignature,
  verifyOrderSignature,
  verifyReviewSignature,
  verifyStatusChain,
} from '../../../../domain/shop';
import type { Identity } from '../../../../domain/identity';
import type {
  HealthResponse,
  Listing,
  ListingsResponse,
  Order,
  OrderMessage,
  OrdersResponse,
  Review,
  ReviewsResponse,
  ThreadPage,
} from '../model';
import { getJson, getJsonParallel, postJson } from '../shopApi';
import { useShopIdentity } from './useShopIdentity';
import { useShopPow, type ShopPowFor } from './useShopPow';

export type ShopTab = 'browse' | 'sell' | 'orders';

export interface ListingForm {
  title: string;
  description: string;
  /** Integer minor units (cents), never a float. */
  price: string;
  stock: string;
  currency: string;
}

export const EMPTY_LISTING_FORM: ListingForm = {
  title: '',
  description: '',
  price: '',
  stock: '',
  currency: 'USD',
};

interface ShopPowProof {
  nonce: number;
  bits: number;
}

function short(hex: string, head = 10): string {
  return hex.length > head + 6 ? `${hex.slice(0, head)}…${hex.slice(-6)}` : hex;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

function charsOf(text: string): number {
  return Array.from(text).length;
}

function withPow(pow: ShopPowProof | null): { pow?: ShopPowProof } {
  return pow ? { pow } : {};
}

/**
 * One provider's marketplace: catalog, own listings, and the private order
 * book for the current identity. Handlers resolve to success/failure so the
 * view can keep a form open when the provider rejects a write.
 */
export function useShop() {
  const [log, setLog] = useState<string[]>([]);
  const append = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-19), `${new Date().toLocaleTimeString()}  ${line}`]);
  }, []);

  const [service, setServiceAddress] = useState(() => loadShopService());
  const [serviceInput, setServiceInput] = useState(service);
  const [tab, setTab] = useState<ShopTab>('browse');
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  const [browseQuery, setBrowseQuery] = useState('');
  const [browse, setBrowse] = useState<Listing[]>([]);
  const [browseNext, setBrowseNext] = useState<number | null>(null);
  const [myListings, setMyListings] = useState<Listing[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [listingMap, setListingMap] = useState<Record<string, Listing>>({});
  const [reviews, setReviews] = useState<Record<string, ReviewsResponse>>({});

  const { identity, loaded: identityLoaded, authed } = useShopIdentity();
  const { powFor } = useShopPow();

  const serviceRef = useRef(service);
  const busyRef = useRef(false);
  const refreshingRef = useRef(false);
  const browseOffsetRef = useRef<number | null>(null);
  const listingCacheRef = useRef<Record<string, Listing>>({});

  useEffect(() => {
    serviceRef.current = service;
  }, [service]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const rememberListings = useCallback((items: Listing[]) => {
    if (items.length === 0) return;
    const next = { ...listingCacheRef.current };
    for (const listing of items) next[listing.id] = listing;
    listingCacheRef.current = next;
    setListingMap(next);
  }, []);

  const listingIsValid = useCallback((listing: Listing): boolean => {
    return verifyListingSignature(
      listing.seller,
      listing.day,
      listing.id,
      listing.version,
      listing.price,
      listing.stock,
      listing.currency,
      listing.title,
      listing.description,
      listing.sig,
    );
  }, []);

  const reviewIsValid = useCallback((review: Review): boolean => {
    return verifyReviewSignature(
      review.author,
      review.day,
      review.order,
      review.seller,
      review.rating,
      review.body,
      review.sig,
    );
  }, []);

  const orderMessagesAreValid = useCallback(
    (order: Order, messages: OrderMessage[]): boolean =>
      messages.every(
        (m) =>
          (m.author === order.buyer || m.author === order.seller) &&
          verifyOrderMessageSignature(m.author, m.day, order.id, m.body, m.sig),
      ),
    [],
  );

  const orderIsValid = useCallback((order: Order): boolean => {
    if (
      !Number.isInteger(order.messages_total) ||
      (order.messages_next_offset !== null && !Number.isInteger(order.messages_next_offset))
    ) {
      return false;
    }
    if (
      !verifyOrderSignature(
        order.buyer,
        order.day,
        order.listing,
        order.id,
        order.qty,
        order.price,
        order.version,
        order.note,
        order.sig,
      )
    ) {
      return false;
    }
    if (
      !Array.isArray(order.status_events) ||
      !verifyStatusChain(
        order.id,
        order.buyer,
        order.seller,
        order.status_code,
        order.status_events,
      )
    ) {
      return false;
    }
    return orderMessagesAreValid(order, order.messages);
  }, [orderMessagesAreValid]);

  const connect = useCallback(
    (input: string) => {
      let address: string;
      try {
        address = splitNymUri(input).address;
      } catch (err) {
        append(`shop address invalid: ${errText(err)}`);
        return false;
      }
      setServiceAddress(address);
      setServiceInput(address);
      saveShopService(address);
      append(`shop: connected to ${short(address)}`);
      return true;
    },
    [append],
  );

  const disconnect = useCallback(() => {
    setServiceAddress('');
    setServiceInput('');
    saveShopService('');
    setBrowse([]);
    setMyListings([]);
    setOrders([]);
    setHealth(null);
    setReviews({});
    browseOffsetRef.current = null;
    append('shop: disconnected');
  }, [append]);

  const loadBrowsePage = useCallback(
    async (reset: boolean, query: string, preserve = false) => {
      if (!service) return;
      const requested = service;
      const offset = reset ? 0 : (browseOffsetRef.current ?? 0);
      setBusy(true);
      try {
        const path = `/listings?offset=${offset}&limit=${DEFAULT_LISTINGS_PAGE}&q=${encodeURIComponent(query)}`;
        const data = await getJson<ListingsResponse>(requested, path);
        if (serviceRef.current !== requested) return;
        const valid = data.listings.filter(listingIsValid);
        if (valid.length !== data.listings.length) {
          append(`${data.listings.length - valid.length} listing(s) failed signature verification`);
        }
        rememberListings(valid);
        setBrowse((prev) => {
          if (preserve) {
            // A silent refresh keeps rows the user already paged in, but puts
            // the freshly fetched first page first so edits become visible.
            const seen = new Set(valid.map((l) => l.id));
            return [...valid, ...prev.filter((l) => !seen.has(l.id))];
          }
          if (reset) return valid;
          const seen = new Set(prev.map((l) => l.id));
          return [...prev, ...valid.filter((l) => !seen.has(l.id))];
        });
        browseOffsetRef.current = data.next;
        setBrowseNext(data.next);
      } catch (err) {
        if (serviceRef.current === requested) append(`browse failed: ${errText(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [service, append, listingIsValid, rememberListings],
  );

  const refreshBrowse = useCallback(
    (query = browseQuery) => {
      browseOffsetRef.current = 0;
      return loadBrowsePage(true, query);
    },
    [browseQuery, loadBrowsePage],
  );

  const loadMore = useCallback(() => {
    if (browseOffsetRef.current === null) return Promise.resolve();
    return loadBrowsePage(false, browseQuery);
  }, [browseQuery, loadBrowsePage]);

  const search = useCallback(
    (query: string) => {
      setBrowseQuery(query);
      browseOffsetRef.current = 0;
      return loadBrowsePage(true, query);
    },
    [loadBrowsePage],
  );

  const loadMyListingsFor = useCallback(
    async (sellerHex: string) => {
      if (!service) return;
      const requested = service;
      try {
        const path = `/listings?offset=0&limit=50&seller=${encodeURIComponent(sellerHex)}`;
        const data = await getJson<ListingsResponse>(requested, path);
        if (serviceRef.current !== requested) return;
        const valid = data.listings.filter(listingIsValid);
        rememberListings(valid);
        setMyListings(valid);
      } catch (err) {
        if (serviceRef.current === requested) append(`own listings failed: ${errText(err)}`);
      }
    },
    [service, append, listingIsValid, rememberListings],
  );

  const loadOrdersFor = useCallback(
    async (id: Identity) => {
      if (!service) return;
      const requested = service;
      setBusy(true);
      try {
        const day = currentDay();
        const sig = signOrdersRead(id.privHex, id.pubHex, day);
        const path = `/orders?for=${id.pubHex}&day=${day}&sig=${sig}`;
        const data = await getJson<OrdersResponse>(requested, path);
        if (serviceRef.current !== requested) return;

        const valid: Order[] = [];
        for (const order of data.orders) {
          if (!orderIsValid(order)) {
            append(`order ${short(order.id)} failed signature verification`);
            continue;
          }
          const review = order.review && reviewIsValid(order.review) ? order.review : null;
          valid.push({ ...order, review });
        }
        setOrders(valid);

        // Resolve listing titles for orders not already in the catalog cache.
        // One tagged burst instead of one awaited round trip per order.
        const missing = [...new Set(valid.map((o) => o.listing))].filter(
          (id) => !listingCacheRef.current[id],
        );
        if (missing.length > 0) {
          try {
            const listings = await getJsonParallel<Listing>(
              requested,
              missing.map((id) => `/listing/${id}`),
            );
            if (serviceRef.current !== requested) return;
            rememberListings(listings.filter(listingIsValid));
          } catch {
            // A deleted or unavailable listing still leaves a readable order;
            // `fetchNymParallel` also retries serially on untagged providers.
          }
        }
      } catch (err) {
        if (serviceRef.current === requested) append(`orders failed: ${errText(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [service, append, listingIsValid, orderIsValid, reviewIsValid, rememberListings],
  );

  const loadOrders = useCallback(async () => {
    if (!identity) {
      append('an identity is required to read orders');
      return;
    }
    await loadOrdersFor(identity);
  }, [identity, append, loadOrdersFor]);

  /** Fetch the next older window of one thread; verify every row locally. */
  const loadOlderMessages = useCallback(
    async (order: Order): Promise<boolean> => {
      if (!service) return false;
      if (order.messages_next_offset === null) return false;
      const requested = service;
      setBusy(true);
      try {
        return await authed(async (id) => {
          if (id.pubHex !== order.buyer && id.pubHex !== order.seller) {
            append('not a party to this order');
            return false;
          }
          const day = currentDay();
          const sig = signOrdersRead(id.privHex, id.pubHex, day);
          const path =
            `/order/${order.id}/messages?for=${id.pubHex}&day=${day}&sig=${sig}` +
            `&offset=${order.messages_next_offset}&limit=${DEFAULT_MESSAGES_PAGE}`;
          const page = await getJson<ThreadPage>(requested, path);
          if (serviceRef.current !== requested) return false;
          if (page.order !== order.id || !orderMessagesAreValid(order, page.messages)) {
            append(`thread page for ${short(order.id)} failed verification`);
            return false;
          }
          setOrders((prev) =>
            prev.map((current) =>
              current.id === order.id
                ? {
                    ...current,
                    messages: [...page.messages, ...current.messages],
                    messages_total: page.total,
                    messages_next_offset: page.next_offset,
                  }
                : current,
            ),
          );
          return true;
        });
      } catch (err) {
        if (serviceRef.current === requested) append(`thread page failed: ${errText(err)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [service, authed, append, orderMessagesAreValid],
  );

  const loadReviews = useCallback(
    async (sellerHex: string) => {
      if (!service) return;
      const requested = service;
      const page = 50;
      const maxPages = 20; // bound work over the mixnet (1000 reviews)
      setBusy(true);
      try {
        const verified: Review[] = [];
        let invalid = 0;
        let truncated = false;
        for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
          const offset = pageIndex * page;
          const data = await getJson<ReviewsResponse>(
            requested,
            `/reviews/${sellerHex}?offset=${offset}&limit=${page}`,
          );
          if (serviceRef.current !== requested) return;
          for (const review of data.reviews) {
            if (reviewIsValid(review)) verified.push(review);
            else invalid += 1;
          }
          if (data.reviews.length < page) break;
          if (pageIndex === maxPages - 1) truncated = true;
        }
        // Recompute from every verified row we fetched; the provider's
        // convenience summary is never trusted for the displayed score.
        const summary = summarizeRatings(verified.map((r) => r.rating));
        if (invalid) append(`${invalid} review(s) failed signature verification`);
        if (truncated) append(`stopped after ${maxPages * page} reviews; reputation is a partial sample`);
        setReviews((prev) => ({
          ...prev,
          [sellerHex.toLowerCase()]: {
            seller: sellerHex,
            reviews: verified,
            summary: { count: summary.count, sum: summary.sum, average_x100: summary.averageX100 },
          },
        }));
      } catch (err) {
        if (serviceRef.current === requested) append(`reviews failed: ${errText(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [service, append, reviewIsValid],
  );

  const placeOrder = useCallback(
    async (listing: Listing, qtyInput: string, note: string): Promise<boolean> => {
      if (!service) return false;
      const qty = parseUint(qtyInput, Math.min(MAX_ORDER_QTY, listing.available));
      if (!qty || qty < 1) {
        append(`quantity must be 1..=${Math.min(MAX_ORDER_QTY, listing.available)}`);
        return false;
      }
      if (bytesOf(note) > MAX_NOTE_BYTES) {
        append(`note too long (max ${MAX_NOTE_BYTES} bytes)`);
        return false;
      }
      setBusy(true);
      try {
        return await authed(async (id) => {
          const day = currentDay();
          const orderId = newIdHex();
          const sig = signOrder(
            id.privHex,
            id.pubHex,
            day,
            listing.id,
            orderId,
            qty,
            listing.price,
            listing.version,
            note,
          );
          const pow = await powFor(
            service,
            id.pubHex,
            orderPowPreimage(listing.id, orderId, qty, listing.price, listing.version, note),
          );
          await postJson(service, '/order', {
            buyer: id.pubHex,
            day,
            id: orderId,
            listing: listing.id,
            qty,
            price: listing.price,
            version: listing.version,
            note,
            sig,
            ...withPow(pow),
          });
          append(`order reserved: ${short(orderId)} (${qty} × ${listing.title})`);
          await refreshBrowse();
          setTab('orders');
          return true;
        });
      } catch (err) {
        append(`order failed: ${errText(err)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [service, authed, powFor, append, refreshBrowse],
  );

  const saveListing = useCallback(
    async (form: ListingForm, editing: Listing | null): Promise<boolean> => {
      if (!service) return false;
      const title = form.title.trim();
      if (!title) {
        append('title is required');
        return false;
      }
      if (charsOf(title) > MAX_TITLE_CHARS) {
        append(`title too long (max ${MAX_TITLE_CHARS} chars)`);
        return false;
      }
      if (charsOf(form.description) > MAX_DESCRIPTION_CHARS) {
        append(`description too long (max ${MAX_DESCRIPTION_CHARS} chars)`);
        return false;
      }
      if (!isCurrencyCode(form.currency)) {
        append('currency must be a 3-letter uppercase code');
        return false;
      }
      const price = parseUint(form.price, Number.MAX_SAFE_INTEGER);
      if (price === null) {
        append('price must be a non-negative integer in minor units');
        return false;
      }
      const stock = parseUint(form.stock, MAX_STOCK);
      if (stock === null) {
        append(`stock must be 0..=${MAX_STOCK}`);
        return false;
      }
      setBusy(true);
      try {
        return await authed(async (id) => {
          const listingId = editing?.id ?? newIdHex();
          const version = editing ? editing.version + 1 : 1;
          const day = currentDay();
          const sig = signListing(
            id.privHex,
            id.pubHex,
            day,
            listingId,
            version,
            price,
            stock,
            form.currency,
            title,
            form.description,
          );
          const pow = await powFor(
            service,
            id.pubHex,
            listingPowPreimage(listingId, version, price, stock, form.currency, title, form.description),
          );
          await postJson(service, '/listing', {
            seller: id.pubHex,
            day,
            id: listingId,
            version,
            price,
            stock,
            currency: form.currency,
            title,
            description: form.description,
            sig,
            ...withPow(pow),
          });
          append(`${editing ? 'listing updated' : 'listing published'}: ${short(listingId)}`);
          await refreshBrowse();
          await loadMyListingsFor(id.pubHex);
          return true;
        });
      } catch (err) {
        append(`listing failed: ${errText(err)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [service, authed, powFor, append, refreshBrowse, loadMyListingsFor],
  );

  const deleteListing = useCallback(
    async (listing: Listing): Promise<boolean> => {
      if (!service) return false;
      setBusy(true);
      try {
        return await authed(async (id) => {
          if (listing.seller !== id.pubHex) {
            append('only the seller may delete this listing');
            return false;
          }
          const day = currentDay();
          const sig = signListingDelete(id.privHex, id.pubHex, listing.id, day);
          const pow = await powFor(service, id.pubHex, listingDeletePowPreimage(listing.id));
          await postJson(service, `/listing/${listing.id}/delete`, {
            seller: id.pubHex,
            day,
            sig,
            ...withPow(pow),
          });
          append(`listing deleted: ${short(listing.id)}`);
          await refreshBrowse();
          await loadMyListingsFor(id.pubHex);
          return true;
        });
      } catch (err) {
        append(`delete failed: ${errText(err)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [service, authed, powFor, append, refreshBrowse, loadMyListingsFor],
  );

  const changeOrderStatus = useCallback(
    async (order: Order, next: number): Promise<boolean> => {
      if (!service) return false;
      setBusy(true);
      try {
        return await authed(async (id) => {
          const role = id.pubHex === order.buyer ? 'buyer' : id.pubHex === order.seller ? 'seller' : null;
          if (!role) {
            append('not a party to this order');
            return false;
          }
          if (!canTransition(role, order.status_code, next)) {
            append(`illegal ${role} transition from ${order.status}`);
            return false;
          }
          const day = currentDay();
          const sig = signOrderStatus(id.privHex, id.pubHex, day, order.id, next, '');
          const pow = await powFor(service, id.pubHex, orderStatusPowPreimage(order.id, next, ''));
          await postJson(service, `/order/${order.id}/status`, {
            actor: id.pubHex,
            day,
            status: next,
            note: '',
            sig,
            ...withPow(pow),
          });
          append(`order ${short(order.id)} → ${orderStatusName(next)}`);
          await loadOrdersFor(id);
          await refreshBrowse();
          if (tab === 'sell') await loadMyListingsFor(id.pubHex);
          return true;
        });
      } catch (err) {
        append(`status failed: ${errText(err)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [service, authed, powFor, append, loadOrdersFor, refreshBrowse, loadMyListingsFor, tab],
  );

  const sendOrderMessage = useCallback(
    async (order: Order, body: string): Promise<boolean> => {
      if (!service) return false;
      const text = body.trim();
      if (!text) return false;
      if (bytesOf(text) > MAX_MESSAGE_BYTES) {
        append(`message too long (max ${MAX_MESSAGE_BYTES} bytes)`);
        return false;
      }
      setBusy(true);
      try {
        return await authed(async (id) => {
          if (id.pubHex !== order.buyer && id.pubHex !== order.seller) {
            append('only the buyer or seller may message on this order');
            return false;
          }
          const day = currentDay();
          const sig = signOrderMessage(id.privHex, id.pubHex, day, order.id, text);
          const pow = await powFor(service, id.pubHex, orderMessagePowPreimage(order.id, text));
          await postJson(service, `/order/${order.id}/message`, {
            author: id.pubHex,
            day,
            body: text,
            sig,
            ...withPow(pow),
          });
          append(`message sent on ${short(order.id)}`);
          await loadOrdersFor(id);
          return true;
        });
      } catch (err) {
        append(`message failed: ${errText(err)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [service, authed, powFor, append, loadOrdersFor],
  );

  const reviewOrder = useCallback(
    async (order: Order, rating: number, body: string): Promise<boolean> => {
      if (!service) return false;
      if (!isValidRating(rating)) {
        append('rating must be 1..=5');
        return false;
      }
      if (bytesOf(body) > MAX_REVIEW_BYTES) {
        append(`review too long (max ${MAX_REVIEW_BYTES} bytes)`);
        return false;
      }
      setBusy(true);
      try {
        return await authed(async (id) => {
          if (id.pubHex !== order.buyer) {
            append('only the buyer may review this order');
            return false;
          }
          const day = currentDay();
          const sig = signReview(id.privHex, id.pubHex, day, order.id, order.seller, rating, body);
          const pow = await powFor(
            service,
            id.pubHex,
            reviewPowPreimage(order.id, order.seller, rating, body),
          );
          await postJson(service, '/review', {
            author: id.pubHex,
            day,
            order: order.id,
            seller: order.seller,
            rating,
            body,
            sig,
            ...withPow(pow),
          });
          append(`review posted for ${short(order.seller)}`);
          await loadOrdersFor(id);
          await loadReviews(order.seller);
          return true;
        });
      } catch (err) {
        append(`review failed: ${errText(err)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [service, authed, powFor, append, loadOrdersFor, loadReviews],
  );

  // Initial catalog + health for the persisted address.
  useEffect(() => {
    if (!service) return;
    void loadBrowsePage(true, '');
    void (async () => {
      try {
        const data = await getJson<HealthResponse>(service, '/health');
        if (serviceRef.current === service) setHealth(data);
      } catch {
        // Health is diagnostic only; browse carries the same failure.
      }
    })();
  }, [service, loadBrowsePage]);

  // Keep the tab's data fresh when it opens.
  useEffect(() => {
    if (tab === 'sell' && service && identity) void loadMyListingsFor(identity.pubHex);
  }, [tab, service, identity, loadMyListingsFor]);

  useEffect(() => {
    if (tab === 'orders' && service && identity) void loadOrdersFor(identity);
  }, [tab, service, identity, loadOrdersFor]);

  // Gentle background refresh: only the open tab, only while visible, never
  // overlapping a user action or another refresh. Mixnet round trips are
  // deliberate and expensive, so this is deliberately slow.
  useEffect(() => {
    if (!service) return;
    const timer = window.setInterval(() => {
      if (document.hidden || busyRef.current || refreshingRef.current) return;
      refreshingRef.current = true;
      const jobs: Promise<unknown>[] = [];
      if (tab === 'browse') jobs.push(loadBrowsePage(true, browseQuery, true));
      if (tab === 'sell' && identity) jobs.push(loadMyListingsFor(identity.pubHex));
      if (tab === 'orders' && identity) jobs.push(loadOrdersFor(identity));
      void Promise.allSettled(jobs).finally(() => {
        refreshingRef.current = false;
      });
    }, 120_000);
    return () => window.clearInterval(timer);
  }, [service, tab, browseQuery, identity, loadBrowsePage, loadMyListingsFor, loadOrdersFor]);

  return {
    log,
    append,
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
    refreshMyListings: () => (identity ? loadMyListingsFor(identity.pubHex) : Promise.resolve()),
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
  };
}

export type ShopState = ReturnType<typeof useShop>;
export type { ShopPowFor };
