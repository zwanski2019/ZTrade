import type { OrderIntent } from "@ztrade/core";
import type { Broker, OrderEvent, SubmitAck, SubmitRequest } from "@ztrade/execution";
import { BybitRest, BybitRestError, type RestConfig } from "./rest.ts";

/**
 * Live Bybit broker — the real implementation of the same `Broker` interface
 * the sim adapter implements.
 *
 * This is the keystone of the prime directive: with this in place, backtest,
 * paper and live all drive the identical engine, and only THIS object differs
 * from the sim adapter. If a strategy behaves differently live, the difference
 * has to be attributable to something in here or to the venue — never to the
 * engine.
 *
 * Two hard rules it upholds:
 *
 *   1. Order state comes from the private EXECUTION stream, never from this
 *      REST response (§11). `submit()` returning 200 means the venue ACCEPTED
 *      the request; it does not mean the order filled, or even that it rested.
 *      So `drainEvents()` is fed by an external account-event source, not by
 *      inferring anything from the POST result.
 *
 *   2. Idempotency (gate #4). The deterministic `orderLinkId` is passed
 *      straight through as Bybit's `orderLinkId`. A retry reuses it, and Bybit
 *      rejects the duplicate — so a timeout-and-retry can never double-fill.
 */
export interface LiveBrokerConfig extends RestConfig {
  /** "linear" for USDT perps. */
  category?: "linear" | "inverse";
  /**
   * True to actually send orders. When false, submit()/cancel() are no-ops
   * that report success — a belt-and-braces paper mode at the adapter layer,
   * independent of the engine's own gating.
   */
  tradingEnabled: boolean;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

/** Bybit's duplicate-clientOrderId rejection. */
const DUPLICATE_ORDER_CODE = 110072;
/** "Order does not exist" — a cancel racing a fill, not an error. */
const ORDER_NOT_FOUND_CODES = new Set([110001, 170213]);

export class BybitLiveBroker implements Broker {
  readonly mode = "live" as const;

  private readonly rest: BybitRest;
  private readonly category: "linear" | "inverse";
  /** orderLinkId → exchange orderId, learned from submit acks. */
  private readonly exchangeIds = new Map<string, string>();
  /** Events pushed here by the account stream; pulled by the engine. */
  private outbox: Array<{ orderLinkId: string; event: OrderEvent; at: number }> = [];

  constructor(private readonly config: LiveBrokerConfig) {
    this.rest = new BybitRest(config);
    this.category = config.category ?? "linear";
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.config.onLog?.(level, message);
  }

  async submit(request: SubmitRequest): Promise<SubmitAck> {
    const { orderLinkId, intent } = request;

    if (!this.config.tradingEnabled) {
      this.log("warn", `PAPER (adapter): would submit ${orderLinkId}`);
      return { accepted: true, exchangeOrderId: null };
    }

    let body: Record<string, unknown>;
    try {
      // Constructed inside the try so a malformed intent — an unexpanded TWAP,
      // say — becomes a graceful rejection rather than an uncaught exception
      // that would crash the engine's tick with positions open.
      body = this.orderBody(orderLinkId, intent);
    } catch (err) {
      return { accepted: false, exchangeOrderId: null, reason: (err as Error).message };
    }

    try {
      const result = await this.rest.post<{ orderId: string; orderLinkId: string }>(
        "/v5/order/create",
        body,
      );
      this.exchangeIds.set(orderLinkId, result.orderId);
      return { accepted: true, exchangeOrderId: result.orderId };
    } catch (err) {
      if (err instanceof BybitRestError) {
        // A duplicate is the SAFE outcome of a retry, not a failure. The
        // original order is live; report it as such so the caller does not
        // treat the retry as a new rejection.
        if (err.retCode === DUPLICATE_ORDER_CODE) {
          return {
            accepted: false,
            exchangeOrderId: this.exchangeIds.get(orderLinkId) ?? null,
            duplicate: true,
            reason: "Duplicate orderLinkId (idempotent retry)",
          };
        }
        return { accepted: false, exchangeOrderId: null, reason: err.retMsg };
      }
      // Network error: we genuinely do not know if it landed. The caller must
      // retry with the SAME orderLinkId, which the duplicate handling makes safe.
      return {
        accepted: false,
        exchangeOrderId: null,
        reason: `Network error (retry with same id): ${(err as Error).message}`,
      };
    }
  }

  async cancel(orderLinkId: string, _at: number): Promise<{ accepted: boolean; reason?: string }> {
    if (!this.config.tradingEnabled) return { accepted: true };

    try {
      await this.rest.post("/v5/order/cancel", {
        category: this.category,
        symbol: this.symbolOf(orderLinkId),
        orderLinkId,
      });
      return { accepted: true };
    } catch (err) {
      if (err instanceof BybitRestError && ORDER_NOT_FOUND_CODES.has(err.retCode)) {
        // Already gone — filled or previously cancelled. From the caller's
        // point of view "there is nothing working" is a success.
        return { accepted: true, reason: "Order already inactive" };
      }
      return { accepted: false, reason: (err as Error).message };
    }
  }

  /**
   * Cancels everything working. Used by the kill switch path, so it must be
   * blunt and tolerant: cancel-all by settle coin, one call, best effort.
   */
  async cancelAll(_at: number): Promise<{ cancelled: number }> {
    if (!this.config.tradingEnabled) return { cancelled: 0 };

    try {
      const result = await this.rest.post<{ list?: Array<{ orderId: string }> }>(
        "/v5/order/cancel-all",
        { category: this.category, settleCoin: "USDT" },
      );
      return { cancelled: result.list?.length ?? 0 };
    } catch (err) {
      this.log("error", `cancelAll failed: ${(err as Error).message}`);
      return { cancelled: 0 };
    }
  }

  drainEvents(): Array<{ orderLinkId: string; event: OrderEvent; at: number }> {
    const events = this.outbox;
    this.outbox = [];
    return events;
  }

  /**
   * Fed by the account WebSocket. This is the ONLY path by which order state
   * changes — the REST response above never produces a fill event.
   */
  ingestOrderEvent(orderLinkId: string, event: OrderEvent, at: number): void {
    if (event.type === "ack") this.exchangeIds.set(orderLinkId, event.exchangeOrderId);
    this.outbox.push({ orderLinkId, event, at });
  }

  exchangeIdFor(orderLinkId: string): string | undefined {
    return this.exchangeIds.get(orderLinkId);
  }

  // --- account snapshots, for the reconciliation loop ---------------------

  async openOrders(): Promise<Array<{ orderLinkId: string; symbol: string; side: string; qty: number }>> {
    const result = await this.rest.get<{ list?: RawOrder[] }>("/v5/order/realtime", {
      category: this.category,
      settleCoin: "USDT",
    });
    return (result.list ?? []).map((o) => ({
      orderLinkId: o.orderLinkId,
      symbol: o.symbol,
      side: o.side,
      qty: Number(o.qty),
    }));
  }

  async positions(): Promise<Array<{ symbol: string; side: string; size: number; entryPrice: number }>> {
    const result = await this.rest.get<{ list?: RawPosition[] }>("/v5/position/list", {
      category: this.category,
      settleCoin: "USDT",
    });
    return (result.list ?? [])
      .filter((p) => Number(p.size) > 0)
      .map((p) => ({
        symbol: p.symbol,
        side: p.side,
        size: Number(p.size),
        entryPrice: Number(p.avgPrice),
      }));
  }

  private orderBody(orderLinkId: string, intent: OrderIntent): Record<string, unknown> {
    const base: Record<string, unknown> = {
      category: this.category,
      symbol: intent.symbol,
      side: intent.side === "buy" ? "Buy" : "Sell",
      qty: String(intent.qty),
      orderLinkId,
      reduceOnly: intent.reduceOnly,
    };

    switch (intent.style.kind) {
      case "market":
        base.orderType = "Market";
        break;
      case "limit":
        base.orderType = "Limit";
        base.price = String(intent.style.price);
        base.timeInForce = intent.style.timeInForce === "PostOnly" ? "PostOnly" : intent.style.timeInForce;
        break;
      case "passive":
        base.orderType = "Limit";
        base.timeInForce = "PostOnly";
        break;
      default:
        // TWAP/iceberg are expanded into child intents upstream by the smart
        // executor; a raw one reaching here is a bug, so fail loudly rather
        // than silently sending a market order.
        throw new Error(`Style ${intent.style.kind} must be expanded before reaching the broker`);
    }

    if (intent.stopLoss !== undefined) base.stopLoss = String(intent.stopLoss);
    if (intent.takeProfit !== undefined) base.takeProfit = String(intent.takeProfit);

    return base;
  }

  private symbolOf(orderLinkId: string): string {
    // orderLinkId does not encode the symbol; the engine tracks it. In practice
    // the reconciler supplies the symbol, so this is only a fallback for a
    // bare cancel — Bybit accepts cancel-by-orderLinkId without a symbol on
    // some endpoints, but linear requires it, so we throw to surface the gap.
    throw new Error(`cancel(${orderLinkId}) needs a symbol; use cancelWithSymbol`);
  }

  /** Cancel when the symbol is known (the normal path from the engine). */
  async cancelWithSymbol(orderLinkId: string, symbol: string): Promise<{ accepted: boolean; reason?: string }> {
    if (!this.config.tradingEnabled) return { accepted: true };
    try {
      await this.rest.post("/v5/order/cancel", { category: this.category, symbol, orderLinkId });
      return { accepted: true };
    } catch (err) {
      if (err instanceof BybitRestError && ORDER_NOT_FOUND_CODES.has(err.retCode)) {
        return { accepted: true, reason: "Order already inactive" };
      }
      return { accepted: false, reason: (err as Error).message };
    }
  }
}

interface RawOrder {
  orderLinkId: string;
  symbol: string;
  side: string;
  qty: string;
}

interface RawPosition {
  symbol: string;
  side: string;
  size: string;
  avgPrice: string;
}
