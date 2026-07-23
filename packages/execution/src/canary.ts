import type { EngineEvent, Intent, Strategy, StrategyContext } from "@ztrade/core";

/**
 * Canary strategy — the parity fixture (ship gate #7).
 *
 * Exists purely to be deterministic. It crosses a fast and slow SMA of closed
 * klines and emits one intent per cross. It is not meant to be profitable and
 * must never be traded.
 *
 * Constraints it deliberately obeys, because violating any of them is what the
 * parity gate is designed to catch:
 *   - no Date.now(), no timers, no I/O
 *   - state derived only from events it was handed
 *   - reset() restores a virgin instance, so one object can replay twice
 */
export class CanaryStrategy implements Strategy {
  readonly id = "canary@1";
  readonly symbols: string[];

  private closes: number[] = [];
  private lastSide: "buy" | "sell" | null = null;

  constructor(
    symbol: string,
    private readonly fast = 3,
    private readonly slow = 8,
    private readonly qty = 0.01,
  ) {
    this.symbols = [symbol];
  }

  reset(): void {
    this.closes = [];
    this.lastSide = null;
  }

  onEvent(event: EngineEvent, ctx: StrategyContext): Intent[] {
    // Only closed klines. Acting on an unclosed bar is itself a lookahead bug.
    if (event.type !== "kline" || !event.closed) return [];
    if (!this.symbols.includes(event.symbol)) return [];

    this.closes.push(event.close);
    if (this.closes.length > this.slow * 4) this.closes.shift();
    if (this.closes.length < this.slow) return [];

    const fastMa = mean(this.closes.slice(-this.fast));
    const slowMa = mean(this.closes.slice(-this.slow));
    const side: "buy" | "sell" = fastMa > slowMa ? "buy" : "sell";

    // Emit only on a change of state, so the tape produces a small, stable set
    // of decisions that a human can eyeball when parity fails.
    if (side === this.lastSide) return [];
    this.lastSide = side;

    return [
      {
        kind: "order",
        intent: {
          key: {
            strategyId: this.id,
            symbol: event.symbol,
            intentSeq: ctx.nextIntentSeq(),
          },
          symbol: event.symbol,
          side,
          qty: this.qty,
          style: { kind: "market" },
          reduceOnly: false,
          rationale: `sma${this.fast}/${this.slow} cross → ${side}`,
        },
      },
    ];
  }
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
