import type { BacktestResult, EquityPoint, StrategyConfig } from "@ztrade/shared";
import type { Candle } from "../exchange/bybit.js";
import { exchange } from "../exchange/bybit.js";
import { instrumentOrFallback } from "../exchange/instruments.js";
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

/** A completed simulated trade, before it is folded into the equity path. */
interface SimTrade {
  closedAt: number;
  pnl: number;
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
 *   - Each symbol is simulated independently and the resulting trades are then
 *     merged in time order. Position sizing therefore does NOT compound across
 *     symbols mid-run, but the equity curve is still chronologically correct.
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

  const perSymbol = await Promise.all(
    strategy.pairs.map(async (symbol) => ({
      symbol,
      candles: await exchange.getCandles(symbol, interval, candleCount),
    })),
  );

  // Collect trades from every symbol first, then build ONE chronological
  // equity path. Accumulating equity symbol-by-symbol and sorting afterwards
  // produces a curve that jumps backwards in time and reports a drawdown that
  // never happened.
  const trades: SimTrade[] = [];

  for (const { symbol, candles } of perSymbol) {
    if (candles.length < impl.warmup + 2) continue;

    const step = instrumentOrFallback(symbol).qtyStep;
    let position: OpenPosition | null = null;

    for (let i = impl.warmup; i < candles.length - 1; i++) {
      const current = candles[i]!;
      const next = candles[i + 1]!;

      if (position) {
        const exit = resolveExit(position, next);
        if (exit !== null) {
          trades.push({
            closedAt: next.openTime,
            pnl: grossPnl(position, exit) - fees(position, exit, feeRate),
          });
          position = null;
        }
        continue;
      }

      const decision = impl.evaluate(candles.slice(0, i + 1), strategy);
      if (decision.action === "HOLD") continue;

      const side = decision.action === "BUY" ? "LONG" : "SHORT";
      const notional = Math.min(strategy.risk.maxPositionSize, startingEquity);
      const qty = quantityFor(notional, current.close, step);
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

  trades.sort((a, b) => a.closedAt - b.closedAt);

  let equity = startingEquity;
  let peak = startingEquity;
  let maxDrawdown = 0;
  let wins = 0;
  const equityCurve: EquityPoint[] = [];

  for (const trade of trades) {
    equity += trade.pnl;
    if (trade.pnl > 0) wins += 1;

    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    equityCurve.push({ at: trade.closedAt, equity, pnl: trade.pnl });
  }

  const from = Math.min(
    ...perSymbol.map((s) => s.candles[0]?.openTime ?? Date.now()),
  );
  const to = Math.max(
    ...perSymbol.map((s) => s.candles.at(-1)?.openTime ?? Date.now()),
  );

  return {
    strategyId: strategy.id,
    from,
    to,
    winRate: trades.length === 0 ? 0 : wins / trades.length,
    maxDrawdown,
    tradesCount: trades.length,
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
