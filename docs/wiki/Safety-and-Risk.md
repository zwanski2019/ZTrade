# Safety and Risk

> **This software places real orders against a real exchange. You can lose money with it.**

## The three switches

All default to the safe position. Reaching real money takes two deliberate,
separate edits — not one typo.

| Switch | Default | Effect |
| :-- | :-- | :-- |
| `ZTRADE_NETWORK` | `TESTNET` | Which Bybit environment |
| `ZTRADE_ALLOW_MAINNET` | `false` | Mainnet is **refused** unless this is *also* `true` |
| `ZTRADE_TRADING_ENABLED` | `false` | Paper mode — strategies run, fills are simulated, **no order is sent** |

Setting `ZTRADE_NETWORK=MAINNET` alone does not work. The server refuses to
start. That is intentional: a single copied `.env` should never be able to point
the bot at real funds.

The server also **refuses to start** with auth disabled while live-trading on
mainnet. An unauthenticated API that can place real orders is not a supported
configuration.

## Layers of protection

They are independent on purpose — each catches what the others cannot.

### 1. Per-trade risk (`packages/risk`)

Seven hard checks before any order: per-symbol notional, aggregate notional,
locally-enforced leverage, daily loss, drawdown from high-water mark, correlated
exposure, order-rate burst, fat-finger price band.

**Leverage is enforced locally, never left to the venue.** An exchange-side cap
can be changed out of band, and by the time it binds you are already exposed.

### 2. Circuit breaker

Three states, not a boolean:

```
NORMAL → DEGRADED (no new risk) → HALT (flatten + freeze)
```

DEGRADED is where most real incidents live: "stop opening new positions but keep
managing what we hold" is the right response to a drawdown. A binary forces a
choice between ignoring the problem and liquidating into it.

Escalation is automatic. **De-escalation never is** — a breaker that clears
itself when a metric dips back under threshold will flap around the boundary,
and every flap is a real order.

**Reduce-only orders survive a tripped breaker.** Blocking them would trap you in
the very position the breaker fired over.

### 3. Kill switch

Runs on a **separate thread** with its own event loop, listener and credentials.
It shares no state with the engine, because any shared structure is one that can
be mid-mutation when the main thread hangs.

The failure it exists for is not "I want to stop" — that is a button. It is
*"the trading loop is wedged and still holding exposure."* An in-process kill
switch is exactly as stuck as the thing it is meant to stop.

It cancels **before** flattening: flattening while resting orders are live can
have them fill against the flattening trade and re-open the position.

### 4. Dead-man's switch 🟡

Bybit's `set_dcp` tells the venue: if this connection drops and does not return,
cancel my orders. It is the only control that survives the process dying.

**Status: built and tested, not yet wired to a live private WS.** See
[Ship Gates](Ship-Gates).

## How this can still lose money

Being straight about it:

- **The strategies are not profitable.** They are textbook MACD, RSI and
  Bollinger. They are here to exercise the infrastructure.
- **Backtests are optimistic by construction.** Fills at the candle close, no
  slippage model on entries, and a candle spanning both stop and target counts
  as a stop. Treat results as bounds, not forecasts.
- **The intelligence weights are unfitted.** No walk-forward validation has been
  done on the conviction model. It is a sanity filter, not an edge.
- **Gate #6 is not met** — the engine does not yet rebuild state on restart. A
  crash mid-position leaves reconciliation to you.
- **Partial fills are not modelled.** A trade row is all-or-nothing.

## Operational rules

- Run on **testnet for weeks** before mainnet. Testnet exposes most of the bugs
  that lose real money.
- Withdrawal-disabled, IP-whitelisted keys. Always.
- Separate keys per environment.
- Bind to `127.0.0.1`. There is no multi-user model.
- Start on mainnet with a size you would be *annoyed* to lose, not one that hurts.
- Scale only after several clean sessions.

## Disclaimer

Not financial advice. No warranty. Cryptocurrency derivatives carry a high risk
of loss, including losses exceeding your deposit. You are solely responsible for
every order this software places.
