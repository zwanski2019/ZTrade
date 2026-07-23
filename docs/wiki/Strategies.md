# Strategies

## What ships

| Kind | Logic | Signals emitted |
| :-- | :-- | :-- |
| **Momentum** | MACD crossover, confirmed by RSI | `MACD_CROSS`, `RSI CONFIRM` |
| **Mean Reversion** | Fade Bollinger pierces at RSI extremes | `OVERBOUGHT`, `OVERSOLD` |
| **Grid** | Step in/out around a rolling mean | `GRID_STEP_n` |
| **Custom Script** | **Inert** — see below | — |

**None of these are profitable.** They are textbook indicators that exist to
exercise the infrastructure. Do not deploy them expecting an edge.

### Why Custom Script is disabled

Running operator-supplied JavaScript needs a real sandbox — worker isolation
plus resource caps. An `eval()` here would be a remote code execution hole in a
process holding exchange credentials. The option stays inert until that sandbox
exists.

## Regime gating

The single highest-value filter. Mean reversion into a strong trend, and
momentum in a chop, are the two classic ways an otherwise sound strategy bleeds
money — and **neither failure is visible to the strategy itself**, which only
sees its own indicator firing correctly.

| Regime | Blocked |
| :-- | :-- |
| `TRENDING` (ADX ≥ 25) | Mean reversion |
| `RANGING` (ADX ≤ 20) | Momentum |
| `VOLATILE` (ATR ≥ 2%) | Grid |
| `TRANSITIONAL` / `UNKNOWN` | Nothing |

An uncertain classification blocks nothing. Refusing to trade because we cannot
classify the market would be worse than trading without the filter.

## Writing your own

```ts
export class MyStrategy implements Strategy {
  readonly id = "my-strategy@1";
  readonly symbols = ["BTCUSDT"];

  private closes: number[] = [];

  onEvent(event: EngineEvent, ctx: StrategyContext): Intent[] {
    if (event.type !== "kline" || !event.closed) return [];

    this.closes.push(event.close);
    if (this.closes.length < 20) return [];

    // ... your logic ...

    return [{
      kind: "order",
      intent: {
        key: { strategyId: this.id, symbol: event.symbol, intentSeq: ctx.nextIntentSeq() },
        symbol: event.symbol,
        side: "buy",
        qty: 0.01,
        style: { kind: "market" },
        reduceOnly: false,
        rationale: "why this trade exists",
      },
    }];
  }

  reset(): void { this.closes = []; }
}
```

### The rules

**Purity is not a style preference.** It is what makes the parity gate possible.

| ❌ Never | ✅ Instead |
| :-- | :-- |
| `Date.now()` | `ctx.clock.now()` — event time |
| `setTimeout` | Express timing as an intent |
| `fetch` / any I/O | Derive from events you were given |
| Call the exchange | Emit an intent; execution owns the broker |
| Act on an unconfirmed bar | Check `event.closed` |

Acting on an unconfirmed bar is a lookahead bug: the close can still move.

`reset()` must restore a virgin instance so one object can be replayed twice.

### Emit intents, not orders

An intent is a **request**. It has no exchange identity, no guarantee of
submission, and no side effects. Risk may veto it; execution decides how to work
it. This is why a strategy bug cannot bypass a risk limit.

## Execution styles

| Style | Behaviour |
| :-- | :-- |
| `market` | Immediate, slippage-guarded against a real book sweep |
| `limit` | Resting at a price, with a time-in-force |
| `passive` | Post-only at the touch, re-pegging as the market moves away |
| `twap` | Even slices across a window |
| `iceberg` | Only `displayQty` shown at a time |

TWAP gives the rounding remainder to the last slice, so the parent is never
quietly short. Post-only re-peg follows the market **away** from you but never
chases it in your favour — if the touch moved your way, your resting price is
already better.

## Position sizing

| Mode | Behaviour |
| :-- | :-- |
| `FIXED_NOTIONAL` | Same position value every time |
| `PERCENT_EQUITY` | Scales with account balance |
| `RISK_BASED` | Constant money at risk — halving the stop distance doubles the position, so the loss at the stop is unchanged |

## Backtesting

```bash
# From the UI: Strategies → Run Backtest
```

Honest about its limits:

- Fills at the candle close, no slippage model on entries
- A candle spanning both stop and target counts as a **stop** (pessimistic)
- One position at a time per symbol
- Each symbol simulated independently, then merged in time order — sizing does
  not compound across symbols mid-run, but the equity curve is chronologically
  correct

Treat results as bounds, not forecasts.
