import type { CloseReason, Position, Trade } from "@ztrade/shared";
import { closeTrade, openTrades, updateTradeProtection } from "../db.js";
import { bus, logger } from "../bus.js";
import { notifier } from "../notify/telegram.js";
import { trailingStopFor } from "./risk.js";

/** Bybit taker fee, charged on entry and again on exit. */
export const TAKER_FEE_RATE = 0.00055;

export function grossPnl(trade: Pick<Trade, "side" | "size" | "entryPrice">, exitPrice: number): number {
  const delta = exitPrice - trade.entryPrice;
  return trade.side === "LONG" ? delta * trade.size : -delta * trade.size;
}

export function roundTripFees(
  trade: Pick<Trade, "size" | "entryPrice">,
  exitPrice: number,
  feeRate = TAKER_FEE_RATE,
): number {
  return (trade.entryPrice * trade.size + exitPrice * trade.size) * feeRate;
}

/** Realised P&L net of both fees — what actually lands in the account. */
export function netPnl(
  trade: Pick<Trade, "side" | "size" | "entryPrice">,
  exitPrice: number,
  feeRate = TAKER_FEE_RATE,
): number {
  return grossPnl(trade, exitPrice) - roundTripFees(trade, exitPrice, feeRate);
}

/**
 * Decides whether an open trade should be closed at the given mark price, and
 * why. Used for paper fills and as a safety net when the exchange's own
 * stop/target did not fire.
 *
 * The stop is checked before the target: when a single price update could
 * satisfy both, assuming the worse outcome keeps simulated results honest.
 */
export function exitFor(
  trade: Pick<Trade, "side" | "stopLoss" | "takeProfit">,
  markPrice: number,
): { price: number; reason: CloseReason } | null {
  const { side, stopLoss, takeProfit } = trade;

  if (side === "LONG") {
    if (stopLoss !== null && markPrice <= stopLoss) {
      return { price: stopLoss, reason: "STOP_LOSS" };
    }
    if (takeProfit !== null && markPrice >= takeProfit) {
      return { price: takeProfit, reason: "TAKE_PROFIT" };
    }
    return null;
  }

  if (stopLoss !== null && markPrice >= stopLoss) {
    return { price: stopLoss, reason: "STOP_LOSS" };
  }
  if (takeProfit !== null && markPrice <= takeProfit) {
    return { price: takeProfit, reason: "TAKE_PROFIT" };
  }
  return null;
}

/**
 * Reconciles open trade rows against reality.
 *
 * Two distinct jobs, because the source of truth differs by mode:
 *
 *   LIVE  — the exchange owns the position. If a trade row is open but the
 *           exchange no longer reports that symbol, the stop or target fired
 *           (or someone closed it by hand) and we must settle the row.
 *   PAPER — nothing exists on the exchange, so the mark price is evaluated
 *           against the recorded stop/target directly.
 *
 * Without this, `pnl` stays 0 forever and every downstream metric — win rate,
 * profit factor, the circuit breaker — is computed over an empty set.
 */
export class Reconciler {
  /**
   * Settles trade rows whose exchange position has vanished.
   * `priceFor` supplies the fill price when the exchange gives us nothing better.
   */
  async reconcileLive(
    positions: Position[],
    priceFor: (symbol: string) => Promise<number | null>,
  ): Promise<Trade[]> {
    const live = new Set(positions.map((p) => p.symbol));
    const settled: Trade[] = [];

    for (const trade of openTrades()) {
      if (trade.paper) continue;
      if (live.has(trade.symbol)) continue;

      const exitPrice = await priceFor(trade.symbol);
      if (exitPrice === null) {
        logger.warn(
          `Trade ${trade.id} (${trade.symbol}) has no exchange position but no ` +
            "price could be fetched to settle it; will retry next tick.",
        );
        continue;
      }

      // The position is already gone, so infer the reason from where it landed
      // rather than claiming to know which order filled.
      const inferred = exitFor(trade, exitPrice);
      const closed = this.settle(
        trade,
        exitPrice,
        inferred?.reason ?? "EXCHANGE",
      );
      if (closed) settled.push(closed);
    }

    return settled;
  }

  /** Evaluates paper trades against the mark price and fills any that hit. */
  async reconcilePaper(markPrices: Map<string, number>): Promise<Trade[]> {
    const settled: Trade[] = [];

    for (const trade of openTrades()) {
      if (!trade.paper) continue;

      const mark = markPrices.get(trade.symbol);
      if (mark === undefined) continue;

      const exit = exitFor(trade, mark);
      if (!exit) continue;

      const closed = this.settle(trade, exit.price, exit.reason);
      if (closed) settled.push(closed);
    }

    return settled;
  }

  /**
   * Ratchets trailing stops on open trades. Returns the trades whose stop moved,
   * so the caller can push the new level to the exchange.
   */
  applyTrailingStops(
    markPrices: Map<string, number>,
    trailingPct: number,
  ): Array<{ trade: Trade; stopLoss: number }> {
    if (trailingPct <= 0) return [];

    const moved: Array<{ trade: Trade; stopLoss: number }> = [];

    for (const trade of openTrades()) {
      const mark = markPrices.get(trade.symbol);
      if (mark === undefined) continue;

      const next = trailingStopFor(trade.side, mark, trade.stopLoss, trailingPct);
      if (next === null) continue;

      updateTradeProtection(trade.id, next, trade.takeProfit);
      moved.push({ trade: { ...trade, stopLoss: next }, stopLoss: next });
      logger.info(
        `Trailing stop for ${trade.symbol} moved to ${next.toFixed(4)} (mark ${mark})`,
      );
    }

    return moved;
  }

  /** Closes one trade row, emits the event and fires the notification. */
  settle(trade: Trade, exitPrice: number, reason: CloseReason): Trade | null {
    const fees = roundTripFees(trade, exitPrice);
    const pnl = grossPnl(trade, exitPrice) - fees;

    const closed = closeTrade({
      id: trade.id,
      closedAt: Date.now(),
      exitPrice,
      pnl,
      fees,
      reason,
    });

    // closeTrade returns null when the row was already settled — a legitimate
    // race between the reconciler and a manual close, not an error.
    if (!closed) return null;

    logger.trade(
      `Position closed ${closed.symbol} ${closed.side} @ ${exitPrice} — ` +
        `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT (${reason})` +
        `${closed.paper ? " [PAPER]" : ""}`,
    );

    bus.emitEvent({ type: "trade", payload: closed });
    void notifier.tradeClosed(closed);

    return closed;
  }
}

export const reconciler = new Reconciler();
