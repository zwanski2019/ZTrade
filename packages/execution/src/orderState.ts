/**
 * Order state machine (§4.5).
 *
 * Every transition is sourced from a private-WS `order`/`execution` event —
 * never inferred from a REST 200 (§11). A REST response tells you the exchange
 * accepted the request; only the execution stream tells you what happened to
 * the order.
 *
 * The machine is PURE: `(state, event) → state | error`. No I/O, no clock, no
 * exchange calls. That is what makes the illegal-state property test possible.
 */

export type OrderState =
  | "NEW" // Created locally, not yet sent.
  | "SUBMITTED" // Sent; no acknowledgement yet. The dangerous window.
  | "ACK" // Exchange acknowledged and it is live on the book.
  | "PARTIAL" // Some quantity has filled.
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED";

export const TERMINAL_STATES: ReadonlySet<OrderState> = new Set([
  "FILLED",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
]);

export function isTerminal(state: OrderState): boolean {
  return TERMINAL_STATES.has(state);
}

export type OrderEvent =
  | { type: "submit" }
  | { type: "ack"; exchangeOrderId: string }
  | { type: "fill"; qty: number; price: number; fee: number; isMaker: boolean }
  | { type: "cancel" }
  | { type: "reject"; reason: string }
  | { type: "expire" };

/**
 * Legal transitions.
 *
 * Two deliberate allowances that look wrong but are not:
 *
 *  - SUBMITTED can go straight to PARTIAL/FILLED. Under load the execution
 *    event can genuinely arrive before the ack; refusing it would drop a real
 *    fill on the floor, which is far worse than a missing ack.
 *  - PARTIAL → CANCELLED is legal and common: the remainder is pulled after a
 *    partial fill. The filled quantity stays filled.
 */
const LEGAL: Record<OrderState, ReadonlySet<OrderState>> = {
  NEW: new Set<OrderState>(["SUBMITTED", "REJECTED"]),
  SUBMITTED: new Set<OrderState>(["ACK", "PARTIAL", "FILLED", "REJECTED", "CANCELLED", "EXPIRED"]),
  ACK: new Set<OrderState>(["PARTIAL", "FILLED", "CANCELLED", "EXPIRED", "REJECTED"]),
  PARTIAL: new Set<OrderState>(["PARTIAL", "FILLED", "CANCELLED", "EXPIRED"]),
  FILLED: new Set<OrderState>(),
  CANCELLED: new Set<OrderState>(),
  REJECTED: new Set<OrderState>(),
  EXPIRED: new Set<OrderState>(),
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return LEGAL[from].has(to);
}

export interface OrderRecord {
  orderLinkId: string;
  exchangeOrderId: string | null;
  symbol: string;
  side: "buy" | "sell";
  /** Total quantity requested. */
  qty: number;
  filledQty: number;
  /** Size-weighted average fill price; 0 until the first fill. */
  avgPrice: number;
  feesPaid: number;
  state: OrderState;
  rejectReason: string | null;
  /** Monotonic counter, incremented on every accepted transition. */
  revision: number;
}

export function newOrder(init: {
  orderLinkId: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
}): OrderRecord {
  return {
    orderLinkId: init.orderLinkId,
    exchangeOrderId: null,
    symbol: init.symbol,
    side: init.side,
    qty: init.qty,
    filledQty: 0,
    avgPrice: 0,
    feesPaid: 0,
    state: "NEW",
    rejectReason: null,
    revision: 0,
  };
}

export type ApplyResult =
  | { ok: true; order: OrderRecord; transitioned: boolean }
  | { ok: false; error: string; order: OrderRecord };

/** Floating-point tolerance for "is this order fully filled?". */
const QTY_EPSILON = 1e-9;

/**
 * Applies an event. Returns a NEW record; never mutates the input, so the
 * caller can keep the prior revision for the journal.
 */
export function applyOrderEvent(order: OrderRecord, event: OrderEvent): ApplyResult {
  // A terminal order is immutable. Late duplicate events after a fill are
  // routine (REST poll racing the WS), so this is an expected no-op, not an
  // error — treating it as an error would spam alerts during normal operation.
  if (isTerminal(order.state)) {
    if (event.type === "fill") {
      return { ok: false, error: `Fill arrived for terminal order (${order.state})`, order };
    }
    return { ok: true, order, transitioned: false };
  }

  switch (event.type) {
    case "submit":
      return transition(order, "SUBMITTED", {});

    case "ack":
      // An ack after a fill must not walk the state backwards.
      if (order.state === "PARTIAL") {
        return { ok: true, order: { ...order, exchangeOrderId: event.exchangeOrderId }, transitioned: false };
      }
      return transition(order, "ACK", { exchangeOrderId: event.exchangeOrderId });

    case "fill": {
      if (event.qty <= 0) {
        return { ok: false, error: "Fill quantity must be positive", order };
      }

      const filledQty = order.filledQty + event.qty;
      if (filledQty > order.qty + QTY_EPSILON) {
        // Overfill means our view of the order is wrong. Refusing it loudly is
        // the only safe response: silently accepting would corrupt position
        // accounting and every risk check downstream of it.
        return {
          ok: false,
          error: `Overfill: ${filledQty} exceeds order quantity ${order.qty}`,
          order,
        };
      }

      // Size-weighted average across all fills so far.
      const avgPrice =
        filledQty > 0
          ? (order.avgPrice * order.filledQty + event.price * event.qty) / filledQty
          : 0;

      const complete = filledQty >= order.qty - QTY_EPSILON;
      return transition(order, complete ? "FILLED" : "PARTIAL", {
        filledQty,
        avgPrice,
        feesPaid: order.feesPaid + event.fee,
      });
    }

    case "cancel":
      if (order.state === "NEW") {
        // Never sent, so there is nothing at the exchange to cancel.
        return transition(order, "CANCELLED", {});
      }
      return transition(order, "CANCELLED", {});

    case "reject":
      return transition(order, "REJECTED", { rejectReason: event.reason });

    case "expire":
      return transition(order, "EXPIRED", {});
  }
}

function transition(
  order: OrderRecord,
  to: OrderState,
  patch: Partial<OrderRecord>,
): ApplyResult {
  if (!canTransition(order.state, to)) {
    return { ok: false, error: `Illegal transition ${order.state} → ${to}`, order };
  }

  return {
    ok: true,
    order: { ...order, ...patch, state: to, revision: order.revision + 1 },
    transitioned: true,
  };
}

/** Quantity still working at the exchange. */
export function remainingQty(order: OrderRecord): number {
  return Math.max(0, order.qty - order.filledQty);
}

/**
 * Is this order still exposed to the market?
 *
 * Used by the kill switch and the reconciliation loop to decide what needs
 * cancelling. SUBMITTED counts as live: we do not know that it did NOT land.
 */
export function isLive(order: OrderRecord): boolean {
  return !isTerminal(order.state);
}
