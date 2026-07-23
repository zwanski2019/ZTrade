import type { OrderBookSnapshot, OrderIntent } from "@ztrade/core";
import { dec, slippageBps, topOfBook } from "@ztrade/core";

/**
 * Smart execution primitives (§4.5).
 *
 * These turn ONE intent into a schedule of child orders. Kept as pure planners
 * — they return what to do and when, they do not send anything — so the
 * schedule is identical in backtest and live, and can be asserted directly.
 */

export interface ChildOrder {
  /** Event time at which this child becomes eligible to send. */
  at: number;
  qty: number;
  /** Null means market. */
  price: number | null;
  postOnly: boolean;
  /** Index within the parent, used to derive a unique child orderLinkId. */
  slice: number;
}

/**
 * TWAP: split evenly across a window.
 *
 * Slicing reduces market impact, but it also converts price risk into timing
 * risk — the last slice trades at whatever the market has become. That is a
 * real trade-off, not a free win, and it is why the window is explicit.
 */
export function planTwap(
  intent: OrderIntent,
  startAt: number,
  qtyStep: number,
): ChildOrder[] {
  if (intent.style.kind !== "twap") return [];

  const { windowMs, slices } = intent.style;
  if (slices <= 0 || windowMs < 0) return [];

  const perSlice = roundDown(intent.qty / slices, qtyStep);
  if (perSlice <= 0) {
    // Slicing this small would produce sub-minimum children. One order is
    // better than a schedule of orders the venue will reject.
    return [{ at: startAt, qty: intent.qty, price: null, postOnly: false, slice: 0 }];
  }

  const children: ChildOrder[] = [];
  let allocated = 0;
  const gap = slices > 1 ? windowMs / (slices - 1) : 0;

  for (let i = 0; i < slices; i++) {
    const isLast = i === slices - 1;
    // The last slice takes the rounding remainder, so the parent quantity is
    // always fully worked rather than quietly short.
    const qty = isLast ? round(intent.qty - allocated, qtyStep) : perSlice;
    if (qty <= 0) continue;

    allocated += qty;
    children.push({
      at: Math.round(startAt + i * gap),
      qty,
      price: null,
      postOnly: false,
      slice: i,
    });
  }

  return children;
}

/**
 * Iceberg: show only `displayQty` at a time.
 *
 * Children are emitted at the same instant because the venue only reveals the
 * next clip once the previous one fills — the sequencing is enforced by fills,
 * not by a timer.
 */
export function planIceberg(
  intent: OrderIntent,
  startAt: number,
  price: number,
  qtyStep: number,
): ChildOrder[] {
  if (intent.style.kind !== "iceberg") return [];

  const display = roundDown(intent.style.displayQty, qtyStep);
  if (display <= 0 || display >= intent.qty) {
    return [{ at: startAt, qty: intent.qty, price, postOnly: true, slice: 0 }];
  }

  const children: ChildOrder[] = [];
  let remaining = intent.qty;
  let slice = 0;

  while (remaining > 0) {
    const qty = round(Math.min(display, remaining), qtyStep);
    if (qty <= 0) break;
    children.push({ at: startAt, qty, price, postOnly: true, slice });
    remaining = round(remaining - qty, qtyStep);
    slice += 1;
  }

  return children;
}

/**
 * Post-only re-peg.
 *
 * Returns the new price when a resting order should move to stay at the touch,
 * or null when it should stay put. Two guards matter:
 *
 *   - Re-peg only when the touch has genuinely moved away from us. Chasing
 *     every flicker burns rate limit and queue position for nothing, and queue
 *     position is the entire economic advantage of resting.
 *   - Stop after `maxRepegs`. An order that has chased the market a dozen
 *     times is an order whose thesis has expired.
 */
export function planRepeg(
  side: "buy" | "sell",
  currentPrice: number,
  book: OrderBookSnapshot,
  repegsSoFar: number,
  maxRepegs: number,
  tickSize: number,
): number | null {
  if (repegsSoFar >= maxRepegs) return null;

  const { bid, ask } = topOfBook(book);
  const touch = side === "buy" ? bid : ask;
  if (touch === null) return null;

  // Already at the touch: moving would only lose queue position.
  if (Math.abs(touch - currentPrice) < tickSize / 2) return null;

  // Only follow the market away from us. If the touch moved in our favour our
  // resting price is now better than the touch, and we should keep it.
  const movedAway = side === "buy" ? touch > currentPrice : touch < currentPrice;
  return movedAway ? touch : null;
}

export type SlippageVerdict =
  | { proceed: true; projectedBps: number }
  | { proceed: false; reason: string; projectedBps: number | null };

/**
 * Slippage guard for marketable orders.
 *
 * Compares against the price a sweep would actually pay, not the mid. Quoting
 * the mid is how a size that eats three levels gets waved through.
 */
export function checkSlippage(
  intent: OrderIntent,
  book: OrderBookSnapshot,
  maxBps: number,
): SlippageVerdict {
  const projected = slippageBps(book, intent.side, intent.qty);

  if (projected === null) {
    // The book cannot fill this size at all. Refusing to extrapolate is the
    // point: assuming invisible liquidity is how you discover it is not there.
    return { proceed: false, reason: "Insufficient visible depth", projectedBps: null };
  }

  const limit = intent.maxSlippageBps ?? maxBps;
  if (projected > limit) {
    return {
      proceed: false,
      reason: `Projected slippage ${projected.toFixed(1)}bps exceeds ${limit}bps`,
      projectedBps: projected,
    };
  }

  return { proceed: true, projectedBps: projected };
}

// Exact step rounding via Decimal — no epsilon nudge. The float version needed
// one because an exact multiple could land at 2.9999… and floor away a whole
// slice; integer-unit arithmetic in Decimal cannot.
function round(value: number, step: number): number {
  if (step <= 0) return value;
  return dec(value).roundToStep(dec(step), "HALF_UP").toNumber();
}

function roundDown(value: number, step: number): number {
  if (step <= 0) return value;
  return dec(value).roundToStep(dec(step), "DOWN").toNumber();
}
