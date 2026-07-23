<div align="center">

# ZTrade

**An event-driven automated trading system for Bybit — built like infrastructure, not like a script.**

[![CI](https://github.com/zwanski2019/ZTrade/actions/workflows/ci.yml/badge.svg)](https://github.com/zwanski2019/ZTrade/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-00FF41.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-informational)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-289%20passing-00FF41)](#testing)

One execution engine. Backtest, paper and live drive the **same code path**.

[Quick start](#quick-start) · [Architecture](#architecture) · [Safety](#-safety-first-read-this) · [Wiki](https://github.com/zwanski2019/ZTrade/wiki) · [Roadmap](#roadmap)

</div>

---

## ⚠️ Safety first — read this

**This software places real orders against a real exchange. You can lose money with it.**

ZTrade ships with three independent safety switches, all defaulting to the safe position:

| Switch | Default | Effect |
| :-- | :-- | :-- |
| `ZTRADE_NETWORK` | `TESTNET` | Which Bybit environment to use |
| `ZTRADE_ALLOW_MAINNET` | `false` | Mainnet is **refused** unless this is *also* `true` |
| `ZTRADE_TRADING_ENABLED` | `false` | Paper mode: strategies run and fills are simulated, but no order is sent |

A fresh checkout runs on testnet, in paper mode, and refuses to touch real funds even if `ZTRADE_NETWORK=MAINNET` is set by accident. Reaching real money takes two deliberate, separate edits.

**None of this makes the bundled strategies profitable.** They are ordinary textbook indicators — MACD, RSI, Bollinger. Backtest results are optimistic by construction. Treat this repository as *infrastructure*, not as financial advice.

> **Not investment advice.** No warranty. You are solely responsible for every order this software places. See [DISCLAIMER.md](DISCLAIMER.md).

---

## Why this exists

Most retail trading bots die of the same two diseases:

1. **Lookahead bias** — the backtest peeks at data the live system will not have, so results are fiction.
2. **Backtest/live divergence** — subtly different code paths mean the strategy you validated is not the strategy you deployed.

ZTrade's prime directive kills both:

> **One execution engine. Backtest, paper and live drive the same code path.**

The only things that change between modes are the **data source** (historical tape vs live WebSocket) and the **broker adapter** (simulated fills vs Bybit REST). Strategy, risk, execution and state machine are byte-for-byte identical.

A CI gate enforces it. If a canary strategy produces different decisions in backtest and paper on the same tape, **the build fails**.

---

## Highlights

| | |
| :-- | :-- |
| 🔁 **Parity-gated** | Backtest and paper must produce byte-identical decisions on the same tape, or CI fails |
| 🛡️ **Independent risk engine** | Seven hard checks + a 3-state circuit breaker. Strategies have no path to a broker — a veto cannot be routed around |
| 🔌 **Out-of-process kill switch** | Runs on its own thread; proven to answer while the main thread is wedged in a busy loop |
| 📖 **L2 orderbook rebuild** | Strict sequence continuity, gap recovery, crossed-book detection. A book that might be wrong **serves nothing** |
| 🧮 **O(1) feature store** | Incremental EMA/ATR/realised-vol on ring buffers, property-tested against full recomputes |
| 🌐 **Market intelligence** | Regime classification, funding, sentiment and cross-venue consensus — from **free, key-free** public APIs |
| 🔐 **Security-first** | Constant-time auth, AES-256-GCM secrets at rest, hash-chained audit log, CI secret-leak gate |
| 📊 **Terminal UI** | Live L2 ladder, P&L, equity curve, strategy config — responsive, dark, high-contrast mode |

---

## Architecture

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
                                                     │
                          ┌──────────────────────────┴──────────────┐
                          ▼                                         ▼
                   Bybit REST adapter                        Sim-fill adapter
                   (live)                                    (backtest / paper)
```

**Strategies are pure.** They receive events and emit *intents* — never orders. No `Date.now()`, no I/O, no exchange access. Time comes from the event, which is what makes replay deterministic.

### Packages

| Package | Responsibility |
| :-- | :-- |
| [`@ztrade/core`](packages/core) | Event types, bus interface, clock, order identity. **Zero exchange dependencies** — this is the boundary |
| [`@ztrade/ingestion`](packages/ingestion) | Bybit WS v5, L2 rebuild, normalisation, tick-to-bar, latency percentiles |
| [`@ztrade/features`](packages/features) | Incremental rolling features on ring buffers |
| [`@ztrade/risk`](packages/risk) | Independent risk engine + 3-state circuit breaker |
| [`@ztrade/execution`](packages/execution) | Order state machine, scheduler, smart execution, kill switch |
| [`@ztrade/adapters-sim`](packages/adapters-sim) | Simulated fills with latency, depth, fees and queue position |
| [`@ztrade/security`](packages/security) | Signing, redaction, hash-chained audit log |
| [`apps/server`](apps/server) | Fastify API, engine, SQLite persistence, market intelligence |
| [`apps/web`](apps/web) | React + Tailwind terminal UI |

---

## Quick start

**Requirements:** Node ≥ 22, pnpm ≥ 9.

```bash
git clone https://github.com/zwanski2019/ZTrade.git
cd ZTrade
pnpm install
cp .env.example .env        # then edit it
pnpm dev                    # server :8788, web :5173
```

On first start the server prints an **API token** — paste it into the UI to get in. Pin it with `ZTRADE_API_TOKEN` in `.env`.

Open <http://localhost:5173>. With no Bybit keys configured the engine still runs on public market data: live signals, backtests, simulated fills and the full UI.

Then: **Strategies → arm one → Dashboard → Start Bot.**

> Create **testnet** keys first: <https://testnet.bybit.com/app/user/api-management>
> Grant **Trade + Read only**. Never enable withdrawal permission on a bot key.

### Commands

```bash
pnpm dev            # server + web
pnpm test           # 289 tests across 10 packages
pnpm typecheck
pnpm build
pnpm gate:parity    # backtest/live decision parity
pnpm gate:secrets   # end-to-end secret leak scan
```

---

## Ship gates

A build is not shippable unless these hold. Status is tracked honestly in [ARCHITECTURE.md](ARCHITECTURE.md).

| # | Gate | Status |
| :-: | :-- | :-- |
| 1 | Kill switch works cold, even when the loop is wedged | ✅ Done |
| 2 | Dead-man's switch armed (`set_dcp`) | 🟡 Built, not yet wired to live private WS |
| 3 | Risk engine can veto independently | ✅ Done |
| 4 | Idempotent orders (deterministic `orderLinkId`) | ✅ Done |
| 5 | No plaintext keys on disk or in logs | ✅ Done |
| 6 | State recovers on restart | ❌ Not done |
| 7 | Backtest == live parity | ✅ Done |

Gates are marked Partial where the *mechanism* exists but live wiring does not. Overstating them is how accounts get drained.

---

## Security

| Control | What it does |
| :-- | :-- |
| **Bearer token auth** | Every route except `/api/health`. Constant-time comparison, auto-generated on first run |
| **WebSocket auth + origin check** | Browsers don't apply CORS to WebSockets; both are enforced at the handshake |
| **Secrets encrypted at rest** | AES-256-GCM with a scrypt-derived key; tampering detected, not silently decrypted |
| **Secrets never returned** | The API emits a masked key and a boolean. Credentials are read-only over HTTP by design |
| **Hash-chained audit log** | `h_n = SHA256(h_{n-1} ‖ entry)`. Editing history breaks the chain at a reportable index |
| **Rate limiting + CSP** | Per-IP limits, Helmet with `default-src 'none'` |
| **CI secret gate** | Boots the real server with sentinel credentials and fails the build if one appears in logs or responses |

Found a vulnerability? See [SECURITY.md](SECURITY.md). **Please do not open a public issue.**

---

## Testing

```
packages/core          18   clock, identity, bus, book maths
packages/security      24   audit chain, redaction, signing
packages/execution     49   order SM (fuzzed), scheduler, smart exec, kill switch
packages/ingestion     38   L2 rebuild, gap recovery, bars, latency
packages/features      16   incremental == batch property tests
packages/risk          25   seven checks, breaker, exposure properties
apps/server           119   strategies, reconciler, crypto, intel
─────────────────────────
                      289   passing
```

Beyond unit tests: **property tests** (the order state machine is fuzzed over 400 seeds; risk can never breach its cap), **acceptance tests** (kill the WS mid-session and prove no stale price escapes), and **gates** wired into CI.

---

## Roadmap

- [x] **Phase 0** — Spine: core types, bus, clock, security, audit chain
- [x] **Phase 1** — Read-only: WS ingestion, L2 rebuild, feature store
- [x] **Phase 2** — Sim loop: sim-fill adapter, canary, parity gate
- [x] **Phase 3** — Risk + execution shell, kill switch
- [ ] **Phase 4** — Paper live: private WS, dead-man armed, reconciliation on testnet
- [ ] **Phase 5** — Small live: mainnet, tiny size, all gates green

See [ARCHITECTURE.md](ARCHITECTURE.md) for per-subsystem failure modes and what is deliberately *not* built.

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first — in particular the rule that **every subsystem PR must state how it fails and how it recovers**.

Non-negotiables:

- Strategies stay pure. No `Date.now()`, no I/O, no direct exchange calls.
- Never assume an order filled because REST returned `200`. Truth is the execution stream.
- No backtest with instant, zero-slippage, zero-fee fills.
- The parity gate must stay green.

---

## Disclaimer

ZTrade is provided **as is**, without warranty of any kind. It is a piece of engineering infrastructure, not financial advice and not a licensed product.

Cryptocurrency derivatives trading carries a **high risk of loss**, including loss exceeding your deposit. Automated systems can fail in ways manual trading does not: a bug, a stale feed, or an exchange outage can produce losses faster than you can react.

Do not run this with money you cannot afford to lose. Do not run it on mainnet until you have run it on testnet for an extended period and understand every line it executes on your behalf. The authors accept no liability for any loss.

Full terms: **[DISCLAIMER.md](DISCLAIMER.md)**

---

## License

[MIT](LICENSE) © [zwanski2019](https://github.com/zwanski2019) — [Zwanski Tech](https://github.com/zwanski2019)
