import type { BacktestResult, EquityPoint, StrategyConfig } from "@ztrade/shared";
import type { Candle } from "../exchange/bybit.js";
import { exchange } from "../exchange/bybit.js";
import { getStrategyImpl } from "../strategies/index.js";
import { protectivePrices, quantityFor } from "./risk.js";

export interface BacktestOptions {
  strategy: StrategyConfig;
  /** Candle interval in minutes, matching Bybit's kline values. */
  interval?: string;
  /** How many candles to replay. */
  candles?: number;
  startingEquity?: number;
  /** Round-trip cost as a fraction of notional; 0.00055 ≈ Bybit taker both ways. */
  feeRate?: number;
}

interface OpenPosition {
  side: "LONG" | "SHORT";
  entryPrice: number;
  qty: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;
}

/**
 * Replays a strategy over historical candles.
 *
 * Deliberate simplifications, because pretending otherwise would make the
 * numbers look better than reality:
 *   - Fills happen at the candle close, with no slippage model.
 *   - Stops and targets are checked against the NEXT candle's high/low. When a
 *     single candle spans both, the stop is assumed to hit first (pessimistic).
 *   - One position at a time per symbol; signals arriving while in a position
 *     are ignored rather than queued.
 */
export async function runBacktest(opts: BacktestOptions): Promise<BacktestResult> {
  const {
    strategy,
    interval = String(strategy.params.interval ?? "5"),
    candles: candleCount = 500,
    startingEquity = 10_000,
    feeRate = 0.00055,
  } = opts;

  const impl = getStrategyImpl(strategy.kind);

  // Pool every allowed pair's results into one equity curve, the same way the
  // live engine shares one account across symbols.
  const perSymbol = await Promise.all(
    strategy.pairs.map(async (symbol) => ({
      symbol,
      candles: await exchange.getCandles(symbol, interval, candleCount),
    })),
  );

  let equity = startingEquity;
  let peak = startingEquity;
  let maxDrawdown = 0;
  let wins = 0;
  let trades = 0;
  const equityCurve: EquityPoint[] = [];

  for (const { candles } of perSymbol) {
    if (candles.length < impl.warmup + 2) continue;

    let position: OpenPosition | null = null;

    for (let i = impl.warmup; i < candles.length - 1; i++) {
      const window = candles.slice(0, i + 1);
      const current = candles[i]!;
      const next = candles[i + 1]!;

      if (position) {
        const exit = resolveExit(position, next);
        if (exit !== null) {
          const pnl = grossPnl(position, exit) - fees(position, exit, feeRate);
          equity += pnl;
          trades += 1;
          if (pnl > 0) wins += 1;

          peak = Math.max(peak, equity);
          maxDrawdown = Math.max(maxDrawdown, peak - equity);
          equityCurve.push({ at: next.openTime, equity, pnl });

          position = null;
        }
        continue;
      }

      const decision = impl.evaluate(window, strategy);
      if (decision.action === "HOLD") continue;

      const side = decision.action === "BUY" ? "LONG" : "SHORT";
      const notional = Math.min(strategy.risk.maxPositionSize, equity);
      const qty = quantityFor(notional, current.close);
      if (qty <= 0) continue;

      const { stopLoss, takeProfit } = protectivePrices(current.close, side, strategy.risk);
      position = {
        side,
        entryPrice: current.close,
        qty,
        stopLoss,
        takeProfit,
        openedAt: current.openTime,
      };
    }
  }

  equityCurve.sort((a, b) => a.at - b.at);

  const from = perSymbol[0]?.candles[0]?.openTime ?? Date.now();
  const to = perSymbol[0]?.candles.at(-1)?.openTime ?? Date.now();

  return {
    strategyId: strategy.id,
    from,
    to,
    winRate: trades === 0 ? 0 : wins / trades,
    maxDrawdown,
    tradesCount: trades,
    netPnl: equity - startingEquity,
    equityCurve,
  };
}

/** Exit price if the stop or target was touched during `candle`, else null. */
function resolveExit(position: OpenPosition, candle: Candle): number | null {
  if (position.side === "LONG") {
    // Stop checked first: when one candle spans both levels we assume the worse.
    if (candle.low <= position.stopLoss) return position.stopLoss;
    if (candle.high >= position.takeProfit) return position.takeProfit;
    return null;
  }
  if (candle.high >= position.stopLoss) return position.stopLoss;
  if (candle.low <= position.takeProfit) return position.takeProfit;
  return null;
}

function grossPnl(position: OpenPosition, exitPrice: number): number {
  const delta = exitPrice - position.entryPrice;
  return position.side === "LONG" ? delta * position.qty : -delta * position.qty;
}

function fees(position: OpenPosition, exitPrice: number, feeRate: number): number {
  const entryNotional = position.entryPrice * position.qty;
  const exitNotional = exitPrice * position.qty;
  return (entryNotional + exitNotional) * feeRate;
}
