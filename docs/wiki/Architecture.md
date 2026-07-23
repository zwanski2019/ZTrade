# Architecture

Event-driven, single-writer core. Everything is a message.

```
                    ┌──────────────────────────────────────────────┐
   Bybit WS v5 ───▶ │  Ingestion  │ normalize → sequence-check      │
   (public)         │             │ → L2 rebuild → staleness guard  │
                    └──────┬───────────────────────────────────────┘
                           │  MarketEvent (typed, venue-agnostic)
                           ▼
   ┌──────────────┐   ┌─────────────────┐   ┌───────────────┐
   │ Feature Store│◀─▶│  Strategy Layer │──▶│  Risk Engine  │  pre-trade veto
   │ (O(1), pure) │   │  (pure, no I/O) │   │ circuit breaker│
   └──────────────┘   └─────────────────┘   └───────┬───────┘
                                                     │ OrderIntent
                                                     ▼
                                             ┌───────────────┐
                                             │  Execution    │  idempotent, rate-aware
                                             │  + Order SM   │  TWAP / iceberg / post-only
                                             └───────┬───────┘
                          ┌──────────────────────────┴──────────────┐
                          ▼                                         ▼
                   Bybit REST adapter                        Sim-fill adapter
                   (live)                                    (backtest / paper)
```

## The three boundaries that matter

### 1. `@ztrade/core` has zero exchange dependencies

If a venue SDK import ever appears there, the normalisation boundary has been
breached and adding a second exchange stops being an adapter change.

Past the ingestion layer, no exchange field name — `S`, `v`, `cumExecQty`,
`confirm` — exists anywhere in the system.

### 2. Strategies emit intents, never orders

```ts
interface Strategy {
  onEvent(event: EngineEvent, ctx: StrategyContext): Intent[];
}
```

`StrategyContext` exposes a clock (event time only), the strategy id, an intent
sequence, and current position. **No bus, no broker, no fetch, no wall-clock.**

A strategy therefore *cannot* route around a risk veto — it has no path to a
broker at all. That independence is the whole point: a bug in strategy code
should be able to lose money slowly, never catastrophically.

### 3. The broker interface is the mode seam

```ts
interface Broker {
  readonly mode: "sim" | "live";
  submit(request: SubmitRequest): Promise<SubmitAck>;
  cancel(orderLinkId: string, at: number): Promise<...>;
  cancelAll(at: number): Promise<{ cancelled: number }>;
  drainEvents(): Array<{ orderLinkId: string; event: OrderEvent; at: number }>;
}
```

Everything **above** this is byte-for-byte identical in backtest, paper and live.
Only the implementation below it changes.

## Event ordering inside the engine

Fixed and deliberate:

1. Advance the clock to the event
2. **Drain broker events** — fills that resolved *before* this moment
3. Let the strategy see the event
4. Risk-check and submit resulting intents

Draining *before* the strategy runs is what guarantees a strategy can never
observe a fill from an order it submitted on the same event. This is structural,
not a convention.

## Packages

| Package | Responsibility |
| :-- | :-- |
| `@ztrade/core` | Events, bus, clock, order identity, book maths |
| `@ztrade/ingestion` | Bybit WS, L2 rebuild, normalisation, bars, latency |
| `@ztrade/features` | O(1) incremental rolling features |
| `@ztrade/risk` | Risk engine + circuit breaker |
| `@ztrade/execution` | Order SM, scheduler, smart exec, kill switch |
| `@ztrade/adapters-sim` | Simulated fills |
| `@ztrade/security` | Signing, redaction, audit chain |
| `apps/server` | API, engine, persistence, intelligence |
| `apps/web` | Terminal UI |

## L2 orderbook

The rule everything follows from:

> **A book that might be wrong serves nothing.**

`snapshot()` returns `null` while stale. There is deliberately no `bestBid()`
that quietly keeps working — that API shape is exactly how bad prices leak into a
strategy.

- Update ids must increment by exactly one. A gap marks the book STALE.
- Further deltas are refused while stale rather than compounding the error.
- Recovery is unsubscribe → resubscribe → fresh snapshot, rebuilt from scratch.
- A socket close invalidates every book immediately: updates that happened while
  we were away are simply gone.
- **Crossed-book detection.** Bybit v5 linear publishes no per-message checksum,
  so this is the strongest integrity signal available. Sequence continuity proves
  we missed nothing; a non-crossed book proves we applied what we got correctly.

## Simulated fills

A backtest with instant, zero-slippage, zero-fee fills is a fabrication. The sim
adapter models:

1. **Latency** — fills resolve only after configured latency has elapsed in
   *event* time. This is the structural defence against lookahead.
2. **Book depth** — market orders sweep real levels, so size pays for itself.
3. **Fees** — maker and taker charged separately. Fee drag is frequently the
   entire difference between a "profitable" backtest and a real loss.
4. **Queue position** — a resting order does not fill because price *touched* its
   level; it fills when price trades *through*, or when enough volume clears the
   queue ahead.

## Failure modes

Every subsystem's failure mode is documented in
[`ARCHITECTURE.md`](https://github.com/zwanski2019/ZTrade/blob/main/ARCHITECTURE.md)
in the repository — what breaks it, how you find out, and what happens next.
