# ZTrade Wiki

**An event-driven automated trading system for Bybit — built like infrastructure, not like a script.**

> **Prime directive:** one execution engine. Backtest, paper and live drive the
> **same code path**. Only the data source and the broker adapter change.

---

## Start here

| Page | What it covers |
| :-- | :-- |
| **[Getting Started](Getting-Started)** | Install, configure, first run |
| **[Safety and Risk](Safety-and-Risk)** | The three switches, and how to lose money with this |
| **[Architecture](Architecture)** | Event flow, packages, the boundaries that matter |
| **[Ship Gates](Ship-Gates)** | What must be true before this trades real money |
| **[Security Model](Security-Model)** | Auth, secrets, audit log, threat model |
| **[Strategies](Strategies)** | What ships, and how to write your own |
| **[Market Intelligence](Market-Intelligence)** | Regime, funding, correlation — from free APIs |
| **[API Reference](API-Reference)** | Every endpoint |
| **[Operations](Operations)** | Running it, watching it, what to do when it breaks |
| **[Roadmap](Roadmap)** | Phases, and what is deliberately not built |

---

## The two diseases this is designed against

Most retail trading bots die of the same two things:

**Lookahead bias.** The backtest sees data the live system will not have. The
strategy looks brilliant and then loses money.

**Backtest/live divergence.** Subtly different code paths mean the strategy you
validated is not the strategy you deployed.

ZTrade attacks both structurally rather than by discipline:

- Strategies are **pure**. `StrategyContext` exposes no wall-clock, no bus, no
  broker, no `fetch` — a strategy *cannot* call `Date.now()` through the
  interface, so replay is deterministic by construction.
- The engine **drains broker events before** the strategy sees an event, so a
  fill can only ever be observed on a later event than its submission.
- A **CI gate** replays a canary strategy through backtest and paper on the same
  tape and fails the build if the decisions differ by a single byte.

---

## Honest status

This is not a finished product. Read [Ship Gates](Ship-Gates) before running it
with money — several safety mechanisms are built and tested but not yet wired to
a live venue, and they are marked as such rather than claimed as done.

**Not investment advice. No warranty. You are responsible for every order it places.**
