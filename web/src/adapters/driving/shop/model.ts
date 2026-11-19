/** JSON shapes returned by `services/shop` (docs/16-shop.md). */

export interface Listing {
  id: string;
  seller: string;
  day: number;
  version: number;
  price: number;
  /** Signed maximum stock; never changes between versions. */
  stock: number;
  /** Derived availability: `stock` minus units held by open/fulfilled orders. */
  available: number;
  currency: string;
  title: string;
  description: string;
  active: boolean;
  sig: string;
}

export interface ListingsResponse {
  listings: Listing[];
  next: number | null;
}

export interface ListingResponse extends Listing {}

export interface OrderMessage {
  author: string;
  day: number;
  body: string;
  sig: string;
}

/** One signed, bounded window of a private order thread. */
export interface ThreadPage {
  order: string;
  messages: OrderMessage[];
  /** Messages stored on this order, not just in this page. */
  total: number;
  /** Count older messages from the newest; `null` at the oldest page. */
  next_offset: number | null;
}

export interface Review {
  order: string;
  seller: string;
  author: string;
  rating: number;
  body: string;
  day: number;
  sig: string;
}

export interface StatusEvent {
  from_code: number;
  status_code: number;
  actor: string;
  day: number;
  note: string;
  sig: string;
}

export interface Order {
  id: string;
  listing: string;
  buyer: string;
  seller: string;
  qty: number;
  /** Signed listing terms at reservation time; never the current price. */
  price: number;
  version: number;
  note: string;
  status: string;
  status_code: number;
  day: number;
  sig: string;
  /** Signed transition chain; replay it to verify the reported status. */
  status_events: StatusEvent[];
  /** Latest page only; older messages come from the paginated thread route. */
  messages: OrderMessage[];
  messages_total: number;
  messages_next_offset: number | null;
  review: Review | null;
}

export interface OrdersResponse {
  orders: Order[];
}

export interface ReviewSummaryWire {
  count: number;
  sum: number;
  average_x100: number;
}

export interface ReviewsResponse {
  seller: string;
  reviews: Review[];
  summary: ReviewSummaryWire;
}

export interface HealthResponse {
  ok: boolean;
  listings: number;
  orders: number;
}

/** `day` (UTC day number) rendered as a short ISO date. */
export function dayLabel(day: number): string {
  return new Date(day * 86_400 * 1000).toISOString().slice(0, 10);
}
