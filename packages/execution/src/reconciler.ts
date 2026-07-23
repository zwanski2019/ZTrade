import type { OrderRecord } from "./orderState.ts";
import { isLive } from "./orderState.ts";

/**
 * Reconciliation loop (§4.5, progress toward ship gate #6).
 *
 * The private WebSocket is the primary source of order truth, but sockets drop
 * messages: a reconnect, a partition, a missed frame. Reconciliation is the
 * safety net — periodically it pulls the exchange's OWN view and diffs it
 * against local state. Any disagreement is resolved TOWARD the exchange,
 * because the exchange is where the money actually is.
 *
 * This is pure: it takes two snapshots and returns the set of corrective
 * actions. The caller decides how to apply them, and a test can assert the
 * diff directly without a venue.
 */

export interface ExchangeOrder {
  orderLinkId: string;
  symbol: string;
}

export interface ExchangePosition {
  symbol: string;
  /** Signed: positive long, negative short. */
  size: number;
}

export type Drift =
  | {
      /** We think this order is live; the exchange has never heard of it. */
      kind: "phantom_order";
      orderLinkId: string;
      detail: string;
    }
  | {
      /** The exchange has a live order we are not tracking. */
      kind: "untracked_order";
      orderLinkId: string;
      symbol: string;
      detail: string;
    }
  | {
      /** Our net position for a symbol disagrees with the exchange's. */
      kind: "position_mismatch";
      symbol: string;
      localSize: number;
      exchangeSize: number;
      detail: string;
    };

export interface ReconcileResult {
  drift: Drift[];
  /** True when nothing disagreed — the common, healthy case. */
  clean: boolean;
}

/** Tolerance for treating two position sizes as equal (exchange step dust). */
const SIZE_EPSILON = 1e-8;

/**
 * Diffs local order/position state against the exchange snapshot.
 *
 * `localOrders` is the engine's order map. `localPositions` is the engine's
 * net position per symbol. The exchange arguments are what a REST pull
 * returned. Everything is a plain value so this can be exhaustively tested.
 */
export function reconcile(
  localOrders: ReadonlyMap<string, OrderRecord>,
  localPositions: ReadonlyMap<string, number>,
  exchangeOrders: readonly ExchangeOrder[],
  exchangePositions: readonly ExchangePosition[],
): ReconcileResult {
  const drift: Drift[] = [];

  const exchangeOrderIds = new Set(exchangeOrders.map((o) => o.orderLinkId));
  const localOrderIds = new Set<string>();

  // 1. Orders we think are live but the exchange does not know about.
  //    Usually a fill/cancel event we missed. The correct fix is to re-query
  //    that specific order's terminal state, not to assume — but flagging it is
  //    the reconciler's job; resolving it is the caller's.
  for (const [orderLinkId, order] of localOrders) {
    if (!isLive(order)) continue;
    localOrderIds.add(orderLinkId);

    if (!exchangeOrderIds.has(orderLinkId)) {
      drift.push({
        kind: "phantom_order",
        orderLinkId,
        detail: `Local order ${order.state} but absent at exchange — likely a missed fill or cancel`,
      });
    }
  }

  // 2. Orders the exchange has live that we are not tracking. This is the
  //    dangerous direction: an untracked order can fill and move our position
  //    without the engine ever knowing.
  for (const order of exchangeOrders) {
    if (!localOrderIds.has(order.orderLinkId)) {
      drift.push({
        kind: "untracked_order",
        orderLinkId: order.orderLinkId,
        symbol: order.symbol,
        detail: "Exchange has a live order the engine is not tracking",
      });
    }
  }

  // 3. Position mismatches. This is the one that actually costs money if
  //    ignored: our risk checks size against a position we do not really hold.
  const exchangeBySymbol = new Map<string, number>();
  for (const position of exchangePositions) exchangeBySymbol.set(position.symbol, position.size);

  const symbols = new Set<string>([...localPositions.keys(), ...exchangeBySymbol.keys()]);
  for (const symbol of symbols) {
    const local = localPositions.get(symbol) ?? 0;
    const exchange = exchangeBySymbol.get(symbol) ?? 0;

    if (Math.abs(local - exchange) > SIZE_EPSILON) {
      drift.push({
        kind: "position_mismatch",
        symbol,
        localSize: local,
        exchangeSize: exchange,
        detail: `Local ${local} vs exchange ${exchange} — engine state will be corrected to the exchange`,
      });
    }
  }

  return { drift, clean: drift.length === 0 };
}

/**
 * Given the drift, the corrective position overrides to apply.
 *
 * The exchange always wins: after applying these, local position state matches
 * the venue exactly. Order-level drift is reported for logging and re-query but
 * not auto-resolved here, because cancelling or force-closing on a single
 * missed message is more dangerous than a brief inconsistency the next event
 * will fix.
 */
export function positionCorrections(result: ReconcileResult): Map<string, number> {
  const corrections = new Map<string, number>();
  for (const drift of result.drift) {
    if (drift.kind === "position_mismatch") {
      corrections.set(drift.symbol, drift.exchangeSize);
    }
  }
  return corrections;
}
