import type { EngineEvent, Intent, Strategy, StrategyContext } from "@ztrade/core";

/**
 * Reference strategies beyond the canary.
 *
 * Like the canary, these are PURE — event in, intents out, no I/O, no clock.
 * They are not claimed to be profitable; they exist to prove the interface
 * carries genuinely different trading logic, and to give the backtester
 * something with real structure to chew on.
 *
 * Each keeps its own bounded state, derived only from events it was handed, so
 * every one is replay-deterministic and works identically in backtest and live.
 */

// ---------------------------------------------------------------------------
// Donchian breakout
// ---------------------------------------------------------------------------

/**
 * Buys a break above the highest close of the last N bars, sells a break below
 * the lowest. The classic trend-following entry: it does nothing in a range
 * and only commits once price has actually made a new extreme.
 *
 * Flips position on an opposite break rather than sitting flat, so a single
 * armed instance is always expressing a directional view once warmed up.
 */
export class BreakoutStrategy implements Strategy {
  readonly id: string;
  readonly symbols: string[];

  private closes: number[] = [];
  private position: "long" | "short" | "flat" = "flat";

  constructor(
    symbol: string,
    private readonly lookback = 20,
    private readonly qty = 0.01,
    version = 1,
  ) {
    this.id = `breakout@${version}`;
    this.symbols = [symbol];
  }

  reset(): void {
    this.closes = [];
    this.position = "flat";
  }

  onEvent(event: EngineEvent, ctx: StrategyContext): Intent[] {
    if (event.type !== "kline" || !event.closed) return [];
    if (!this.symbols.includes(event.symbol)) return [];

    // Compare against the window that EXCLUDES the current bar — comparing a
    // bar to a window that contains it is a subtle lookahead that makes every
    // breakout look inevitable.
    const priorHigh = this.closes.length >= this.lookback ? Math.max(...this.closes.slice(-this.lookback)) : null;
    const priorLow = this.closes.length >= this.lookback ? Math.min(...this.closes.slice(-this.lookback)) : null;

    this.closes.push(event.close);
    if (this.closes.length > this.lookback * 3) this.closes.shift();
    if (priorHigh === null || priorLow === null) return [];

    let side: "buy" | "sell" | null = null;
    if (event.close > priorHigh && this.position !== "long") side = "buy";
    else if (event.close < priorLow && this.position !== "short") side = "sell";
    if (side === null) return [];

    this.position = side === "buy" ? "long" : "short";
    return [order(this.id, event.symbol, side, this.qty, ctx, `donchian ${this.lookback} breakout`)];
  }
}

// ---------------------------------------------------------------------------
// VWAP mean reversion
// ---------------------------------------------------------------------------

/**
 * Fades price when it stretches too far from a rolling VWAP.
 *
 * VWAP anchors "fair value" to where volume actually traded, so a large
 * deviation is a stretched move that tends to snap back. It buys when price is
 * `band`% BELOW vwap and sells when it is that far above — the opposite
 * temperament to the breakout above, and deliberately so: the two exist to
 * show the regime filter has real work to do.
 *
 * Uses closed klines with their volume, approximating VWAP by the bar's close
 * (a true VWAP needs intra-bar prints, which the kline stream does not carry).
 */
export class VwapReversionStrategy implements Strategy {
  readonly id: string;
  readonly symbols: string[];

  private priceVolume: number[] = [];
  private volume: number[] = [];
  private position: "long" | "short" | "flat" = "flat";

  constructor(
    symbol: string,
    private readonly window = 20,
    private readonly bandPct = 1.5,
    private readonly qty = 0.01,
    version = 1,
  ) {
    this.id = `vwap-reversion@${version}`;
    this.symbols = [symbol];
  }

  reset(): void {
    this.priceVolume = [];
    this.volume = [];
    this.position = "flat";
  }

  onEvent(event: EngineEvent, ctx: StrategyContext): Intent[] {
    if (event.type !== "kline" || !event.closed) return [];
    if (!this.symbols.includes(event.symbol)) return [];

    const volume = event.volume > 0 ? event.volume : 1;
    this.priceVolume.push(event.close * volume);
    this.volume.push(volume);
    if (this.priceVolume.length > this.window) {
      this.priceVolume.shift();
      this.volume.shift();
    }
    if (this.priceVolume.length < this.window) return [];

    const totalVolume = this.volume.reduce((a, b) => a + b, 0);
    if (totalVolume <= 0) return [];
    const vwap = this.priceVolume.reduce((a, b) => a + b, 0) / totalVolume;

    const deviation = ((event.close - vwap) / vwap) * 100;
    const band = this.bandPct;

    let side: "buy" | "sell" | null = null;
    // Price stretched below fair value → fade up. Above → fade down.
    if (deviation <= -band && this.position !== "long") side = "buy";
    else if (deviation >= band && this.position !== "short") side = "sell";
    if (side === null) return [];

    this.position = side === "buy" ? "long" : "short";
    return [
      order(this.id, event.symbol, side, this.qty, ctx, `vwap dev ${deviation.toFixed(2)}%`),
    ];
  }
}

// ---------------------------------------------------------------------------

function order(
  strategyId: string,
  symbol: string,
  side: "buy" | "sell",
  qty: number,
  ctx: StrategyContext,
  rationale: string,
): Intent {
  return {
    kind: "order",
    intent: {
      key: { strategyId, symbol, intentSeq: ctx.nextIntentSeq() },
      symbol,
      side,
      qty,
      style: { kind: "market" },
      reduceOnly: false,
      rationale,
    },
  };
}
