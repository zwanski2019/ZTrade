import {
  Engine,
  positionCorrections,
  reconcile,
  RecoveryGate,
  recoverState,
  type ExchangeOrder,
  type ExchangePosition,
  type JournalStore,
  type OrderEvent,
  type RiskGate,
} from "@ztrade/execution";
import type { Strategy } from "@ztrade/core";
import { BybitLiveBroker } from "./liveBroker.ts";
import { BybitPrivateWs } from "./privateWs.ts";

/**
 * Phase 4 live pipeline.
 *
 * Assembles the pieces into a system that can run against Bybit testnet with
 * real WS/REST and real latency:
 *
 *   private WS  ──account events──▶  live broker  ──drained by──▶  engine
 *        │                                                            │
 *        └── position stream ──▶ reconciliation loop ◀── exchange pull ┘
 *                                        │
 *                                   journal (durable) ── cold-start recovery
 *
 * The two safety-critical behaviours it owns:
 *
 *   - COLD START (gate #6): rebuild state from the journal, reconcile against
 *     the venue, and refuse to trade until reconciled. Fails closed.
 *   - RECONCILIATION: periodically diff engine state against exchange truth and
 *     correct position drift toward the venue.
 *
 * Market events are fed in from outside (the Phase 1 ingestion), so this module
 * stays free of a WS-market dependency and remains unit-testable by pushing
 * events directly.
 */
export interface LivePipelineConfig {
  strategy: Strategy;
  broker: BybitLiveBroker;
  privateWs: BybitPrivateWs;
  journal: JournalStore;
  risk?: RiskGate;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  now?: () => number;
}

export class LivePipeline {
  readonly engine: Engine;
  private readonly gate = new RecoveryGate();
  private readonly now: () => number;
  /** Latest venue positions from the private stream, for reconciliation. */
  private readonly streamedPositions = new Map<string, number>();
  /** orderLinkIds already recorded with an "open" entry. */
  private readonly journaledOpens = new Set<string>();

  readonly stats = { reconciliations: 0, driftsFound: 0, corrections: 0, journaled: 0 };

  constructor(private readonly config: LivePipelineConfig) {
    this.now = config.now ?? (() => Date.now());
    this.engine = new Engine({
      strategy: config.strategy,
      broker: config.broker,
      risk: config.risk,
    });
  }

  /**
   * The account-event handler. Wire the private WS's `onAccountEvent` to this.
   *
   * Ordering is deliberate and durability-first:
   *   1. journal the event (and an "open" marker the first time we see an order)
   *      SYNCHRONOUSLY, so a crash immediately after cannot lose it
   *   2. only then feed the broker, whose outbox the engine drains next tick
   *
   * The "open" marker's symbol/side/qty come from the order the engine created
   * at submit time — it is already in the order book by the time any account
   * event arrives, so recovery has everything it needs to seed the record.
   */
  handleAccountEvent(orderLinkId: string, event: OrderEvent, at: number): void {
    const record = this.engine.orderBook().get(orderLinkId);
    if (record && !this.journaledOpens.has(orderLinkId)) {
      this.config.journal.append({
        t: "open",
        at,
        orderLinkId,
        symbol: record.symbol,
        side: record.side,
        qty: record.qty,
      });
      this.journaledOpens.add(orderLinkId);
      this.stats.journaled += 1;
    }

    this.config.journal.append({ t: "event", at, orderLinkId, event });
    this.stats.journaled += 1;

    this.config.broker.ingestOrderEvent(orderLinkId, event, at);
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.config.onLog?.(level, message);
  }

  get canTrade(): boolean {
    return this.gate.canTrade;
  }

  /** Records a streamed position, used as a fast reconciliation input. */
  onStreamedPosition(symbol: string, size: number, side: string): void {
    const signed = side === "Sell" ? -Math.abs(size) : Math.abs(size);
    this.streamedPositions.set(symbol, signed);
  }

  /**
   * Cold start (gate #6). Rebuild from the journal, reconcile against the
   * venue, and only then open the gate. Refuses to trade on failure.
   */
  async coldStart(): Promise<{ recovered: number; reconciled: boolean }> {
    this.gate.block();

    const entries = this.config.journal.read();
    const recovered = recoverState(entries);
    this.engine.restoreOrders(recovered.orders);
    for (const [symbol, size] of recovered.positions) {
      this.engine.overridePosition(symbol, size);
    }
    this.log(
      "info",
      `Recovered ${recovered.orders.size} order(s), ${recovered.positions.size} position(s) from journal`,
    );

    // Reconcile the rebuilt state against exchange truth before allowing trading.
    try {
      const clean = await this.runReconciliation();
      if (clean) {
        this.gate.markReconciled();
        this.config.journal.append({
          t: "reconciled",
          at: this.now(),
          detail: "cold start reconciled",
        });
        this.log("info", "Cold start reconciled — trading enabled");
      } else {
        this.log(
          "warn",
          "Cold start found drift; corrected toward exchange and enabling trading",
        );
        this.gate.markReconciled();
      }
      return { recovered: recovered.orders.size, reconciled: true };
    } catch (err) {
      // Fail CLOSED. A reconciliation we could not complete leaves trading off.
      this.log("error", `Cold start reconciliation failed: ${(err as Error).message}`);
      return { recovered: recovered.orders.size, reconciled: false };
    }
  }

  /**
   * One reconciliation pass. Returns true when nothing disagreed.
   *
   * Pulls the venue's open orders and positions, diffs against engine state,
   * and applies position corrections toward the exchange. Order-level drift is
   * logged for a human, not auto-resolved.
   */
  async runReconciliation(): Promise<boolean> {
    this.stats.reconciliations += 1;

    const [rawOrders, rawPositions] = await Promise.all([
      this.config.broker.openOrders(),
      this.config.broker.positions(),
    ]);

    const exchangeOrders: ExchangeOrder[] = rawOrders.map((o) => ({
      orderLinkId: o.orderLinkId,
      symbol: o.symbol,
    }));
    const exchangePositions: ExchangePosition[] = rawPositions.map((p) => ({
      symbol: p.symbol,
      size: p.side === "Sell" ? -p.size : p.size,
    }));

    const localPositions = new Map<string, number>();
    for (const symbol of this.enginePositionSymbols(exchangePositions)) {
      localPositions.set(symbol, this.engine.positionOf(symbol));
    }

    const result = reconcile(
      this.engine.orderBook(),
      localPositions,
      exchangeOrders,
      exchangePositions,
    );

    if (!result.clean) {
      this.stats.driftsFound += result.drift.length;
      for (const drift of result.drift) this.log("warn", `Drift: ${drift.detail}`);

      const corrections = positionCorrections(result);
      for (const [symbol, size] of corrections) {
        this.engine.overridePosition(symbol, size);
        this.stats.corrections += 1;
      }
    }

    return result.clean;
  }

  /** Symbols to reconcile: everything the exchange reports plus what we track. */
  private enginePositionSymbols(exchangePositions: ExchangePosition[]): Set<string> {
    const symbols = new Set<string>(exchangePositions.map((p) => p.symbol));
    for (const [, order] of this.engine.orderBook()) symbols.add(order.symbol);
    for (const symbol of this.streamedPositions.keys()) symbols.add(symbol);
    return symbols;
  }
}
