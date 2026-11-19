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
  note: string;
  status: string;
  status_code: number;
  day: number;
  sig: string;
  /** Signed transition chain; replay it to verify the reported status. */
  status_events: StatusEvent[];
  messages: OrderMessage[];
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
