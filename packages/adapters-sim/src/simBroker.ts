import type { OrderBookSnapshot } from "@ztrade/core";
import { exceedsLimitBps, sweepPrice, topOfBook } from "@ztrade/core";
import type { Broker, SubmitAck, SubmitRequest } from "@ztrade/execution";
import type { OrderEvent } from "@ztrade/execution";

/**
 * Simulated fill adapter (§5).
 *
 * A backtest with instant, zero-slippage, zero-fee fills is a lie (§11), so
 * this models the four things that actually decide whether a strategy survives
 * contact with a real venue:
 *
 *   1. LATENCY — a fill resolves only after the measured round-trip has
 *      elapsed in EVENT time, never on the same event that submitted it. This
 *      is the structural defence against lookahead bias.
 *   2. BOOK DEPTH — market orders sweep real levels, so size pays for itself.
 *      An order larger than the visible book does not fill at the top price.
 *   3. FEES — maker and taker are charged separately. Fee drag is frequently
 *      the entire difference between a "profitable" backtest and a real loss.
 *   4. QUEUE POSITION — a post-only order does not fill because price touched
 *      its level; it fills when price TRADES THROUGH, or when enough volume
 *      executes at that level to clear the queue ahead of it.
 */
export interface SimConfig {
  /** One-way latency in millis, applied to every submission. */
  latencyMs: number;
  makerFeeRate: number;
  takerFeeRate: number;
  /**
   * Fraction of resting size at our price level assumed to be ahead of us.
   * 1.0 is pessimistic and correct for a naive post-only: you join the back.
   */
  queueAheadFactor: number;
  /** Reject market orders whose swept price exceeds this slippage. */
  maxSlippageBps: number;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  latencyMs: 50,
  makerFeeRate: 0.0002,
  takerFeeRate: 0.00055,
  queueAheadFactor: 1,
  maxSlippageBps: 50,
};

interface PendingOrder {
  orderLinkId: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  filled: number;
  /** Null for market orders. */
  limitPrice: number | null;
  postOnly: boolean;
  /** Event time at which the exchange is considered to have received it. */
  visibleAt: number;
  /** Remaining volume that must trade at our level before we fill. */
  queueAhead: number;
  acked: boolean;
}

export class SimBroker implements Broker {
  readonly mode = "sim" as const;

  private pending = new Map<string, PendingOrder>();
  private outbox: Array<{ orderLinkId: string; event: OrderEvent; at: number }> = [];
  private books = new Map<string, OrderBookSnapshot>();
  private seenLinkIds = new Set<string>();

  constructor(private readonly config: SimConfig = DEFAULT_SIM_CONFIG) {}

  /** Feed the current book before advancing time. */
  updateBook(symbol: string, book: OrderBookSnapshot): void {
    this.books.set(symbol, book);
  }

  async submit(request: SubmitRequest): Promise<SubmitAck> {
    const { orderLinkId, intent, at } = request;

    // Idempotency (ship gate #4): the venue rejects a duplicate clientOrderId,
    // so a retry after a timeout is a safe no-op rather than a second position.
    if (this.seenLinkIds.has(orderLinkId)) {
      return {
        accepted: false,
        exchangeOrderId: null,
        duplicate: true,
        reason: "Duplicate orderLinkId",
      };
    }
    this.seenLinkIds.add(orderLinkId);

    const book = this.books.get(intent.symbol);
    if (!book) {
      return { accepted: false, exchangeOrderId: null, reason: "No book for symbol" };
    }

    const style = intent.style;
    const limitPrice =
      style.kind === "limit" ? style.price : style.kind === "passive" ? nearTouch(book, intent.side) : null;
    const postOnly =
      style.kind === "passive" || (style.kind === "limit" && style.timeInForce === "PostOnly");

    // Slippage guard on marketable orders, evaluated against real depth.
    if (limitPrice === null) {
      const swept = sweepPrice(book, intent.side, intent.qty);
      if (swept === null) {
        return { accepted: false, exchangeOrderId: null, reason: "Insufficient book depth" };
      }
      const { mid } = topOfBook(book);
      if (mid !== null && mid > 0) {
        const bps = ((intent.side === "buy" ? swept - mid : mid - swept) / mid) * 10_000;
        const limit = intent.maxSlippageBps ?? this.config.maxSlippageBps;
        if (exceedsLimitBps(bps, limit)) {
          return {
            accepted: false,
            exchangeOrderId: null,
            reason: `Projected slippage ${bps.toFixed(1)}bps exceeds ${limit}bps`,
          };
        }
      }
    }

    this.pending.set(orderLinkId, {
      orderLinkId,
      symbol: intent.symbol,
      side: intent.side,
      qty: intent.qty,
      filled: 0,
      limitPrice,
      postOnly,
      // The order is not live until the round trip completes. Nothing may fill
      // before this instant, which is what forbids same-event lookahead.
      visibleAt: at + this.config.latencyMs,
      queueAhead: limitPrice === null ? 0 : this.queueAheadAt(book, intent.side, limitPrice),
      acked: false,
    });

    return { accepted: true, exchangeOrderId: `sim-${orderLinkId}` };
  }

  async cancel(orderLinkId: string, at: number): Promise<{ accepted: boolean; reason?: string }> {
    const order = this.pending.get(orderLinkId);
    if (!order) return { accepted: false, reason: "Unknown order" };

    this.pending.delete(orderLinkId);
    this.outbox.push({ orderLinkId, event: { type: "cancel" }, at: at + this.config.latencyMs });
    return { accepted: true };
  }

  async cancelAll(at: number): Promise<{ cancelled: number }> {
    const ids = [...this.pending.keys()];
    for (const id of ids) await this.cancel(id, at);
    return { cancelled: ids.length };
  }

  drainEvents(): Array<{ orderLinkId: string; event: OrderEvent; at: number }> {
    const events = this.outbox;
    this.outbox = [];
    return events;
  }

  /**
   * Advances simulated time to `now`, resolving anything that should have
   * happened by then. The engine calls this once per event, so fills are
   * always discovered on a LATER event than the submission.
   */
  step(now: number, symbol: string, book: OrderBookSnapshot, tradedVolume = 0, tradePrice?: number): void {
    this.books.set(symbol, book);

    for (const order of [...this.pending.values()]) {
      if (order.symbol !== symbol) continue;
      if (now < order.visibleAt) continue; // Still in flight.

      if (!order.acked) {
        order.acked = true;
        this.outbox.push({
          orderLinkId: order.orderLinkId,
          event: { type: "ack", exchangeOrderId: `sim-${order.orderLinkId}` },
          at: now,
        });
      }

      if (order.limitPrice === null) {
        this.fillMarket(order, book, now);
      } else {
        this.fillLimit(order, book, now, tradedVolume, tradePrice);
      }
    }
  }

  private fillMarket(order: PendingOrder, book: OrderBookSnapshot, now: number): void {
    const remaining = order.qty - order.filled;
    const price = sweepPrice(book, order.side, remaining);
    if (price === null) return; // Not enough depth; wait for the book to refill.

    order.filled = order.qty;
    this.pending.delete(order.orderLinkId);
    this.outbox.push({
      orderLinkId: order.orderLinkId,
      event: {
        type: "fill",
        qty: remaining,
        price,
        fee: remaining * price * this.config.takerFeeRate,
        isMaker: false,
      },
      at: now,
    });
  }

  /**
   * A resting order fills only when the market actually trades through it, or
   * when enough volume executes at its price to exhaust the queue ahead.
   *
   * Modelling this is what stops a mean-reversion backtest from looking
   * brilliant: naively, every wick that touches your bid is a fill, and in
   * reality most of them are not.
   */
  private fillLimit(
    order: PendingOrder,
    book: OrderBookSnapshot,
    now: number,
    tradedVolume: number,
    tradePrice?: number,
  ): void {
    const limit = order.limitPrice!;
    const { bid, ask } = topOfBook(book);
    if (bid === null || ask === null) return;

    // Price traded strictly through our level: we are filled regardless of queue.
    const throughUs = order.side === "buy" ? ask < limit : bid > limit;

    if (!throughUs) {
      // Price is only AT our level. Consume queue with observed volume.
      const atOurLevel = tradePrice !== undefined && Math.abs(tradePrice - limit) < 1e-9;
      if (!atOurLevel || tradedVolume <= 0) return;

      order.queueAhead -= tradedVolume;
      if (order.queueAhead > 0) return; // Still behind others in the queue.
    }

    const remaining = order.qty - order.filled;
    order.filled = order.qty;
    this.pending.delete(order.orderLinkId);

    this.outbox.push({
      orderLinkId: order.orderLinkId,
      event: {
        type: "fill",
        qty: remaining,
        price: limit, // A resting order fills at its own price, never better.
        fee: remaining * limit * this.config.makerFeeRate,
        isMaker: true,
      },
      at: now,
    });
  }

  /** Size resting at our price that must clear before we are filled. */
  private queueAheadAt(book: OrderBookSnapshot, side: "buy" | "sell", price: number): number {
    const levels = side === "buy" ? book.bids : book.asks;
    const level = levels.find((l) => Math.abs(l.price - price) < 1e-9);
    return (level?.size ?? 0) * this.config.queueAheadFactor;
  }

  /** Number of orders still working — used by tests and the kill switch. */
  get openCount(): number {
    return this.pending.size;
  }
}

function nearTouch(book: OrderBookSnapshot, side: "buy" | "sell"): number | null {
  const { bid, ask } = topOfBook(book);
  return side === "buy" ? bid : ask;
}
