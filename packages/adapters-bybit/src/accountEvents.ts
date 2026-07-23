import type { OrderEvent } from "@ztrade/execution";

/**
 * Translates Bybit private-stream `order` and `execution` messages into the
 * engine's OrderEvents.
 *
 * This is where "truth is the execution stream" (§11) is made concrete. An
 * `execution` message is a real fill and becomes a `fill` event. An `order`
 * message is a status transition and becomes ack/cancel/reject/expire.
 *
 * The mapping is intentionally explicit rather than clever: Bybit's status
 * vocabulary is large and a few statuses are ambiguous, so anything
 * unrecognised is dropped with the caller able to log it, never guessed.
 */

export interface RawExecution {
  orderLinkId: string;
  execQty: number;
  execPrice: number;
  execFee: number;
  isMaker: boolean;
  execTime: number;
}

export interface RawOrderUpdate {
  orderLinkId: string;
  orderId: string;
  orderStatus: string;
  updatedTime: number;
}

/** A fill is unambiguous: it always maps to a fill event. */
export function executionToEvent(exec: RawExecution): {
  orderLinkId: string;
  event: OrderEvent;
  at: number;
} {
  return {
    orderLinkId: exec.orderLinkId,
    event: {
      type: "fill",
      qty: exec.execQty,
      price: exec.execPrice,
      fee: exec.execFee,
      isMaker: exec.isMaker,
    },
    at: exec.execTime,
  };
}

/**
 * Maps an order-status update to an event, or null when it carries no state
 * change the machine cares about.
 *
 * Notably `Filled`/`PartiallyFilled` return null here: those transitions are
 * driven by the `execution` stream, which carries the price and quantity an
 * `order` update does not. Acting on both would double-count.
 */
export function orderUpdateToEvent(
  update: RawOrderUpdate,
): { orderLinkId: string; event: OrderEvent; at: number } | null {
  const make = (event: OrderEvent) => ({
    orderLinkId: update.orderLinkId,
    event,
    at: update.updatedTime,
  });

  switch (update.orderStatus) {
    case "New":
    case "Untriggered":
      return make({ type: "ack", exchangeOrderId: update.orderId });

    case "Cancelled":
    case "Deactivated":
      return make({ type: "cancel" });

    case "Rejected":
      return make({ type: "reject", reason: "Rejected by exchange" });

    // Bybit does not have a distinct "expired" order status for linear; a
    // time-in-force expiry surfaces as Cancelled, already handled above.

    // Fills come from the execution stream, which has the price and size.
    case "Filled":
    case "PartiallyFilled":
    case "PartiallyFilledCanceled":
      return null;

    default:
      // Unknown status: return null so the caller can log and drop it rather
      // than the machine receiving a guessed transition.
      return null;
  }
}

/** True when a status is one the machine handles via the order stream. */
export function isHandledOrderStatus(status: string): boolean {
  return ["New", "Untriggered", "Cancelled", "Deactivated", "Rejected"].includes(status);
}
