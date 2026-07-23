# Contributing to ZTrade

Thanks for considering a contribution. This is trading infrastructure, so the
bar is a little different from a typical web project: a bug here does not
render a page wrong, it loses money.

## The rules that matter

These are not style preferences. A PR violating one will be asked to change.

### 1. Strategies stay pure

A strategy receives events and returns intents. That is all.

```ts
// ✅
onEvent(event, ctx) { return [{ kind: "order", intent: {...} }]; }

// ❌ breaks replay determinism — the parity gate will catch it
onEvent(event, ctx) { if (Date.now() > deadline) { ... } }

// ❌ strategies have no path to a broker, by design
onEvent(event, ctx) { await exchange.submitOrder(...); }
```

No `Date.now()`, no `setTimeout`, no `fetch`, no exchange access. Time comes
from the event. If you need something not on `StrategyContext`, you are almost
certainly asking for the wrong thing.

### 2. Truth is the execution stream

Never assume an order filled because a REST call returned `200`. A REST
response tells you the venue *accepted the request*. Only the private
WebSocket `execution` event tells you what happened to the order.

### 3. No flattering simulations

Any change to the sim adapter must keep modelling latency, book depth, fees and
queue position. A backtest with instant, zero-slippage, zero-fee fills is not
an optimistic estimate — it is a fabrication.

### 4. The parity gate is a build blocker

```bash
pnpm gate:parity
```

If backtest and paper produce different decisions on the same tape, every
backtest number in this repository is fiction until it is green again.

### 5. State how it fails

Every subsystem PR must include a short paragraph in the description:

> **How this fails and how it recovers.**

Not a formality. If you cannot describe the failure mode, the subsystem is not
finished. See [ARCHITECTURE.md](ARCHITECTURE.md) for the existing ones.

## Getting set up

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Everything defaults to testnet + paper mode. You do not need exchange
credentials to develop — the engine runs on public market data.

## Before you open a PR

```bash
pnpm typecheck      # must be clean
pnpm test           # all packages
pnpm gate:parity    # decision parity
pnpm gate:secrets   # no secret reaches a log sink
```

## Testing expectations

Unit tests are the floor. For anything on a money path we prefer:

- **Property tests** for invariants — "risk can never breach the cap under any
  fuzzed sequence" is worth more than ten hand-picked cases
- **Acceptance tests** for failure paths — the ones that only run when
  something is already going wrong are precisely the ones that must be proven
- **Deterministic fixtures** — seed your PRNG. A flaky test on a trading system
  trains people to ignore red

Write the test that would have caught the bug, not the test that passes.

## Commit and PR style

- Conventional-ish subjects: `feat(risk): ...`, `fix(ingestion): ...`
- Explain *why*, not *what* — the diff already shows what
- One logical change per PR

## Code style

- TypeScript strict. No `any` on a money path
- Comments explain the reasoning a reader could not infer. Skip the ones that
  restate the code
- Prefer explicit over clever. Someone will read this at 3am while positions
  are open

## Security

Never open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).

Never commit `.env`, keys, or a real `orderLinkId` from a live account.
