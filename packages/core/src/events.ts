/**
 * Normalised market and account events.
 *
 * Nothing exchange-specific crosses this boundary. Bybit's field names, its
 * string-encoded numbers and its topic shapes all die in the ingestion layer.
 * That is what makes a second exchange an adapter change rather than a rewrite
 * of every strategy.
 *
 * Every event carries BOTH timestamps:
 *   exchangeTs  — when the venue says it happened
 *   localRecvTs — when we actually received it
 * The delta is the latency budget, and it is the only honest way to model fill
 * delay in a simulator.
 */

export type Symbol = string;

export interface EventMeta {
  /** Venue-reported event time, epoch millis. */
  exchangeTs: number;
  /** Local receive time, epoch millis. Equals exchangeTs on a replayed tape. */
  localRecvTs: number;
  /** Monotonic per-stream sequence, used to detect gaps. */
  seq: number;
}

export interface PriceLevel {
  price: number;
  size: number;
}

/** A full L2 book snapshot, already sorted best-first. */
export interface OrderBookSnapshot {
  bids: PriceLevel[];
  asks: PriceLevel[];
}

export type MarketEvent =
  | ({ type: "book"; symbol: Symbol; book: OrderBookSnapshot } & EventMeta)
  | ({ type: "trade"; symbol: Symbol; price: number; size: number; side: "buy" | "sell" } & EventMeta)
  | ({ type: "ticker"; symbol: Symbol; lastPrice: number; markPrice: number; indexPrice: number } & EventMeta)
  | ({ type: "kline"; symbol: Symbol; interval: string; open: number; high: number; low: number; close: number; volume: number; closed: boolean } & EventMeta)
  | ({ type: "funding"; symbol: Symbol; rate: number; nextFundingTs: number } & EventMeta);

/** Account-side truth. Never inferred from a REST response — see §11. */
export type AccountEvent =
  | ({ type: "order"; symbol: Symbol; orderLinkId: string; exchangeOrderId: string | null; status: string; filledQty: number; avgPrice: number } & EventMeta)
  | ({ type: "execution"; symbol: Symbol; orderLinkId: string; execQty: number; execPrice: number; fee: number; isMaker: boolean } & EventMeta)
  | ({ type: "position"; symbol: Symbol; size: number; side: "long" | "short" | "flat"; entryPrice: number } & EventMeta)
  | ({ type: "wallet"; equity: number; available: number } & EventMeta);

export type EngineEvent = MarketEvent | AccountEvent;

/** Best bid/ask from a book, or null when a side is empty. */
export function topOfBook(book: OrderBookSnapshot): {
  bid: number | null;
  ask: number | null;
  mid: number | null;
} {
  const bid = book.bids[0]?.price ?? null;
  const ask = book.asks[0]?.price ?? null;
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
  return { bid, ask, mid };
}

/**
 * Size-weighted price you would actually pay to take `qty` from the book.
 *
 * This is what a slippage guard must compare against — not the mid, and not
 * the top level, which is usually far too thin to fill a real order.
 * Returns null when the book cannot fill the whole quantity.
 */
export function sweepPrice(
  book: OrderBookSnapshot,
  side: "buy" | "sell",
  qty: number,
): number | null {
  if (qty <= 0) return null;

  const levels = side === "buy" ? book.asks : book.bids;
  let remaining = qty;
  let notional = 0;

  for (const level of levels) {
    const take = Math.min(remaining, level.size);
    notional += take * level.price;
    remaining -= take;
    if (remaining <= 0) break;
  }

  // Refusing to extrapolate past the book is deliberate: a bot that assumes
  // liquidity it cannot see is a bot that discovers the truth in production.
  if (remaining > 0) return null;
  return notional / qty;
}

/** Projected slippage in basis points versus the mid. */
export function slippageBps(
  book: OrderBookSnapshot,
  side: "buy" | "sell",
  qty: number,
): number | null {
  const { mid } = topOfBook(book);
  if (mid === null || mid <= 0) return null;

  const sweep = sweepPrice(book, side, qty);
  if (sweep === null) return null;

  const signed = side === "buy" ? sweep - mid : mid - sweep;
  return (signed / mid) * 10_000;
}

/**
 * Tolerance for basis-point threshold comparisons.
 *
 * A sweep price is computed as notional/qty, which accumulates binary-float
 * dust: sweeping 0.01 at 100.5 yields 100.50000000000001, and an order sitting
 * EXACTLY on a 50bps limit is then rejected for exceeding it by 2e-14 bps.
 *
 * Every threshold comparison in a risk path must go through this. Silent
 * boundary rejections are maddening to debug in production because the order
 * looks perfectly legal in the logs.
 */
export const BPS_EPSILON = 1e-6;

/** True only when `actual` genuinely exceeds the limit, not float dust above it. */
export function exceedsLimitBps(actual: number, limitBps: number): boolean {
  return actual > limitBps + BPS_EPSILON;
}

/**
 * Orderbook imbalance in [-1, 1]: +1 all bid, -1 all ask.
 * A microstructure feature that is cheap to compute and genuinely predictive
 * at short horizons.
 */
export function bookImbalance(book: OrderBookSnapshot, depth = 5): number {
  const bidSize = book.bids.slice(0, depth).reduce((s, l) => s + l.size, 0);
  const askSize = book.asks.slice(0, depth).reduce((s, l) => s + l.size, 0);
  const total = bidSize + askSize;
  return total === 0 ? 0 : (bidSize - askSize) / total;
}
