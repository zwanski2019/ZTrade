import type {
  EngineEvent,
  Intent,
  MarketEvent,
  OrderIntent,
  Strategy,
  StrategyContext,
} from "@ztrade/core";
import { ReplayClock, orderLinkId } from "@ztrade/core";
import type { Broker } from "./broker.ts";
import { applyOrderEvent, newOrder, type OrderRecord } from "./orderState.ts";

/**
 * The single execution loop (§0).
 *
 * Backtest, paper and live all run THIS function. The only injected
 * differences are the event source (historical tape vs live socket) and the
 * broker (sim-fill vs Bybit REST). Strategy, risk and order-state handling are
 * identical by construction, which is the only way parity can be asserted
 * rather than hoped for.
 *
 * Ordering within one event is fixed and deliberate:
 *   1. advance the clock to the event
 *   2. drain broker events (fills that resolved BEFORE this moment)
 *   3. let the strategy see the event
 *   4. risk-check and submit resulting intents
 *
 * Draining before the strategy runs is what guarantees a strategy can never
 * observe a fill from an order it submitted on this same event — the
 * structural defence against lookahead.
 */
export interface RiskGate {
  /** Return null to allow, or a reason string to veto. */
  check(intent: OrderIntent, ctx: { positions: Map<string, number> }): string | null;
}

/** Every decision the engine made, in order. This is what parity compares. */
export interface DecisionRecord {
  at: number;
  seq: number;
  kind: "submitted" | "vetoed" | "rejected" | "cancelled";
  orderLinkId: string;
  symbol: string;
  side: string;
  qty: number;
  detail: string;
}

export interface EngineOptions {
  strategy: Strategy;
  broker: Broker;
  risk?: RiskGate;
  /** Called on every accepted order-state transition; used for the journal. */
  onTransition?: (order: OrderRecord) => void;
}

export class Engine {
  private readonly clock = new ReplayClock();
  private readonly orders = new Map<string, OrderRecord>();
  private readonly positions = new Map<string, number>();
  private readonly decisions: DecisionRecord[] = [];
  private intentSeq = 0;

  constructor(private readonly options: EngineOptions) {}

  get decisionLog(): readonly DecisionRecord[] {
    return this.decisions;
  }

  positionOf(symbol: string): number {
    return this.positions.get(symbol) ?? 0;
  }

  orderBook(): ReadonlyMap<string, OrderRecord> {
    return this.orders;
  }

  /**
   * Overrides the engine's net position for a symbol.
   *
   * Reconciliation-only. The exchange is the source of truth for what we
   * actually hold, so when the reconciler finds a mismatch it forces the engine
   * to the venue's number. Nothing else should call this — a strategy or the
   * normal fill path adjusting position through here would hide real drift.
   */
  overridePosition(symbol: string, size: number): void {
    if (size === 0) this.positions.delete(symbol);
    else this.positions.set(symbol, size);
  }

  /** Seeds recovered orders on cold start, before any new event is processed. */
  restoreOrders(orders: ReadonlyMap<string, OrderRecord>): void {
    for (const [id, order] of orders) this.orders.set(id, order);
  }

  /** Processes one event end to end. */
  async handle(event: EngineEvent): Promise<void> {
    this.clock.advanceTo(event.exchangeTs);

    // 1. Apply anything the broker resolved before now.
    this.drainBroker();

    // 2. Strategy sees the event and may emit intents.
    const ctx: StrategyContext = {
      clock: this.clock,
      strategyId: this.options.strategy.id,
      nextIntentSeq: () => this.intentSeq++,
      positionOf: (symbol) => this.positionOf(symbol),
    };

    const intents = this.options.strategy.onEvent(event, ctx);

    // 3. Risk, then submit.
    for (const intent of intents) {
      await this.processIntent(intent);
    }
  }

  private drainBroker(): void {
    for (const { orderLinkId: id, event, at } of this.options.broker.drainEvents()) {
      const existing = this.orders.get(id);
      if (!existing) continue;

      const result = applyOrderEvent(existing, event);
      if (!result.ok) {
        this.decisions.push({
          at,
          seq: this.decisions.length,
          kind: "rejected",
          orderLinkId: id,
          symbol: existing.symbol,
          side: existing.side,
          qty: existing.qty,
          detail: result.error,
        });
        continue;
      }

      this.orders.set(id, result.order);
      if (result.transitioned) this.options.onTransition?.(result.order);

      // Position accounting follows the execution stream, never a REST reply.
      if (event.type === "fill") {
        const signed = existing.side === "buy" ? event.qty : -event.qty;
        this.positions.set(existing.symbol, this.positionOf(existing.symbol) + signed);
      }
    }
  }

  private async processIntent(intent: Intent): Promise<void> {
    if (intent.kind === "cancel") {
      const result = await this.options.broker.cancel(
        intent.intent.targetOrderLinkId,
        this.clock.now(),
      );
      this.decisions.push({
        at: this.clock.now(),
        seq: this.decisions.length,
        kind: "cancelled",
        orderLinkId: intent.intent.targetOrderLinkId,
        symbol: intent.intent.symbol,
        side: "-",
        qty: 0,
        detail: result.accepted ? intent.intent.reason : (result.reason ?? "cancel failed"),
      });
      return;
    }

    const order = intent.intent;
    const id = orderLinkId(order.key);

    // Risk runs OUTSIDE the strategy and can veto unconditionally (§4.4).
    const veto = this.options.risk?.check(order, { positions: this.positions }) ?? null;
    if (veto !== null) {
      this.decisions.push({
        at: this.clock.now(),
        seq: this.decisions.length,
        kind: "vetoed",
        orderLinkId: id,
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        detail: veto,
      });
      return;
    }

    const record = newOrder({
      orderLinkId: id,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
    });
    const submitted = applyOrderEvent(record, { type: "submit" });
    if (submitted.ok) this.orders.set(id, submitted.order);

    const ack = await this.options.broker.submit({
      orderLinkId: id,
      intent: order,
      at: this.clock.now(),
    });

    this.decisions.push({
      at: this.clock.now(),
      seq: this.decisions.length,
      kind: ack.accepted ? "submitted" : "rejected",
      orderLinkId: id,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      detail: ack.accepted ? order.rationale : (ack.reason ?? "rejected"),
    });

    if (!ack.accepted) {
      const current = this.orders.get(id);
      if (current) {
        const rejected = applyOrderEvent(current, {
          type: "reject",
          reason: ack.reason ?? "rejected",
        });
        if (rejected.ok) this.orders.set(id, rejected.order);
      }
    }
  }
}

/** Convenience: is this a market event the sim broker should step on? */
export function isMarketEvent(event: EngineEvent): event is MarketEvent {
  return event.type === "book" || event.type === "trade" || event.type === "ticker" ||
    event.type === "kline" || event.type === "funding";
}
