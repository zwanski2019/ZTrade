# ZTrade — Bybit Trading Terminal

An automated Bybit trading bot with a terminal-style control UI. Built from the
Stitch designs in [`design/reference/`](design/reference) — the phosphor-green-on-black,
zero-radius, JetBrains Mono aesthetic is lifted from them verbatim.

```
apps/server      Fastify API + execution engine + Bybit adapter + SQLite
apps/web         Vite + React + Tailwind terminal UI
packages/shared  Domain types shared by both
```

---

## ⚠️ Read this before you run it

This software places real orders against a real exchange. It ships with three
independent safety switches, all defaulting to the safe position:

| Switch | Default | Effect |
| --- | --- | --- |
| `ZTRADE_NETWORK` | `TESTNET` | Which Bybit environment to use |
| `ZTRADE_ALLOW_MAINNET` | `false` | Mainnet is refused unless this is *also* `true` |
| `ZTRADE_TRADING_ENABLED` | `false` | Paper mode: strategies run and fills are **simulated**, but no order is sent |

A fresh checkout runs on testnet, in paper mode, and refuses to touch real funds
even if `ZTRADE_NETWORK=MAINNET` is set by accident. Reaching real money takes
two deliberate, separate edits.

**None of this makes the strategies profitable.** They are ordinary textbook
indicators. Backtest results are optimistic by construction (see below). Treat
this as infrastructure, not as advice — you are responsible for what it trades.

Other precautions worth taking:

- Create **testnet** keys first: <https://testnet.bybit.com/app/user/api-management>
- Grant the key **Trade + Read only**. Never enable withdrawal permission on a bot key.
- `.env` is gitignored. Keep it that way.

---

## Quick start

```bash
pnpm install
cp .env.example .env      # then edit it
pnpm dev                  # server on :8788, web on :5173
```

On first start the server prints an **API token** — paste it into the UI to get
in. Pin it by setting `ZTRADE_API_TOKEN` in `.env`.

Open <http://localhost:5173>. With no Bybit keys configured the engine still
runs on public market data — live signals, backtests, simulated fills and the
full UI, just no real account balance.

Then: **Strategies → arm one → Dashboard → Start Bot.**

```bash
pnpm dev:server / pnpm dev:web
pnpm test        # 119 unit + integration tests
pnpm typecheck
pnpm build
```

---

## Security

| Control | What it does |
| --- | --- |
| **Bearer token auth** | Every route except `/api/health` requires `Authorization: Bearer <token>`. Compared in constant time so the token cannot be recovered by timing. Auto-generated on first run, so the API is never accidentally left open. |
| **WebSocket auth + origin check** | Browsers do not apply CORS to WebSockets. Both are enforced at the handshake, so a hostile page cannot open a socket to your local ZTrade and watch your trades. Loopback aliases (`localhost` ⇄ `127.0.0.1`) are treated as equivalent. |
| **Secrets encrypted at rest** | The Telegram bot token is stored AES-256-GCM encrypted with a scrypt-derived key. Tampering is detected, not silently decrypted. |
| **Secrets never returned** | The API only ever emits a masked key and a `hasSecret` boolean. Exchange credentials are read-only over HTTP by design — `PUT /api/settings/exchange` returns `405`. |
| **Rate limiting** | Per-IP, configurable via `ZTRADE_RATE_LIMIT`. `trustProxy` is pinned to loopback so the header cannot be spoofed. |
| **Security headers** | Helmet with a `default-src 'none'` CSP — the API serves JSON and a socket, never HTML. |
| **Audit log** | Append-only record of engine start/stop, emergency stops, strategy and settings changes, and auth failures, with source IP. Survives restarts, unlike the rolling log buffer. |
| **Startup refusal** | The server will not start with auth disabled while live-trading on mainnet. |

There is still **no multi-user model**. Bind to `127.0.0.1` and treat the token
as a single shared credential.

---

## How it works

**Execution engine** (`apps/server/src/engine/engine.ts`) is a state machine —
`STOPPED → STARTING → RUNNING → STOPPING`, plus `ERROR`. While running it:

- pings Bybit every 5s for the heartbeat and latency readout,
- every 15s reconciles open positions, then evaluates the armed strategy,
- records every signal — **including why one was skipped**,
- pushes everything to the browser over one WebSocket.

**Only one strategy is armed at a time**, matching the dashboard's single
"Active Strategy" slot. Arming is explicit — the seeded default starts disabled.

**Reconciliation** (`engine/reconciler.ts`) is what closes trades. In live mode
the exchange owns the position, so a trade row whose symbol has vanished from
the exchange is settled at the current price. In paper mode there is nothing on
the exchange, so the mark price is evaluated against the recorded stop/target
directly. Settling is idempotent — a manual close racing the reconciler cannot
double-count the P&L. Realised P&L is always **net of both fees**; a trade
closed at its entry price is a small loss, as it should be.

**Risk** (`engine/risk.ts`) is the single choke point before any order. It
enforces the daily trade cap, one-position-per-symbol, allowed pairs, max
concurrent positions and the global risk cap, then clamps size to whichever
ceiling binds first. Quantities respect the instrument's real `qtyStep`,
`minOrderQty` and `minNotional` fetched from Bybit, and always round **down** —
rounding up could exceed the limit that was just approved.

Three sizing modes:

| Mode | Behaviour |
| --- | --- |
| `FIXED_NOTIONAL` | Same position value every time |
| `PERCENT_EQUITY` | Scales with the account balance |
| `RISK_BASED` | Constant money at risk: halving the stop distance doubles the position, so the loss at the stop stays the same |

**Circuit breaker** (`engine/circuitBreaker.ts`) sits above per-trade risk.
Per-trade limits cap one bad trade; this caps a bad *day*. Ten trades each
losing an "acceptable" 1% is still a 10% drawdown, and no per-trade rule can see
that coming. Trips on a daily loss percentage or a consecutive-loss streak, then
halts new entries for a cooldown. It does **not** flatten open positions unless
`flattenOnTrip` is set — closing into a spike is often worse than holding.

**Trailing stops** ratchet only in the profitable direction and are pushed to
the exchange, so the worst case improves monotonically.

**Strategies** (`strategies/index.ts`):

| Kind | Logic | Signals it emits |
| --- | --- | --- |
| Momentum | MACD crossover, confirmed by RSI | `MACD_CROSS`, `RSI CONFIRM` |
| Mean Reversion | Fade Bollinger pierces at RSI extremes | `OVERBOUGHT`, `OVERSOLD` |
| Grid | Step in/out around a rolling mean | `GRID_STEP_n` |
| Custom | **Inert.** See below | — |

Custom Script is deliberately not implemented. Running operator-supplied JS
would need a real sandbox (worker + resource caps); an `eval()` here would be a
remote code execution hole, so the option stays disabled until that exists.

**Backtests** are honest about their limits: fills are modelled at the candle
close with no slippage, and a candle spanning both stop and target counts as a
stop. Each symbol is simulated independently and the trades are then merged in
time order, so position sizing does not compound across symbols mid-run but the
equity curve is chronologically correct.

---

## Market intelligence

A layer of context built entirely on **free, key-free public APIs**. Every
provider is optional: if one is unreachable the corresponding intelligence is
simply absent and the engine keeps trading on price alone. Failures never throw,
results are cached, and stale data is served in preference to nothing.

| Source | Provides | Cost |
| --- | --- | --- |
| alternative.me | Crypto Fear & Greed index | free, no key |
| Binance futures (public) | Funding rate, open interest + history, long/short ratio | free, no key |
| CoinGecko (public) | BTC dominance, total market cap, 24h change | free, no key |
| Coinbase + Kraken (public) | Independent spot prices for cross-venue consensus | free, no key |
| Bybit klines | Regime, volatility and correlation, from the prices we actually trade | free |

What it does with them:

**Regime classification** (ADX + ATR) labels the market TRENDING / RANGING /
VOLATILE / TRANSITIONAL, and blocks strategies that do not suit it. Mean
reversion into a strong trend and momentum in a chop are the two classic ways a
sound strategy bleeds money, and neither failure is visible to the strategy
itself — it only sees its own indicator firing correctly. An uncertain
classification blocks nothing.

**Correlation guard.** Three positions in BTC, ETH and SOL is not three
positions. On real mainnet 5m data those pairs correlate at **0.81–0.89**, so
without this check the "max open positions" limit silently permits exactly the
concentration it was meant to prevent. Correlation is computed on returns, not
prices — two assets that both drift up have a high price correlation almost by
construction.

**Cross-venue consensus guard.** Our price is compared against the median of
independent venues. A large deviation means the feed is stale or the book is
broken — precisely when a bot should stop rather than act.

**Conviction scoring** folds the strategy's own confidence together with regime
agreement, funding (crowd positioning), sentiment and open-interest trend into
one 0–1 score that gates the entry and scales the size. Size scaling is bounded
to 0.5×–1.0×: conviction may shrink a position but **never** grow it beyond what
the risk limits approved.

**Volatility stops** derive the stop distance from ATR instead of a fixed
percentage, so "the move went genuinely against me" means the same thing in a
calm market and a wild one. Optional, off by default.

Honest limits: the scoring weights are reasoned defaults, not fitted parameters.
Sentiment and funding are slow, noisy inputs that matter mainly at extremes.
Correlation is backward-looking. Treat the score as a filter against obviously
bad entries, not as alpha.

---

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | The only unauthenticated route |
| `GET` | `/api/dashboard` | Everything the dashboard needs in one round trip |
| `GET` | `/api/status` | Engine state, breaker state, open position count |
| `POST` | `/api/engine/start` \| `/stop` | |
| `POST` | `/api/engine/emergency-stop` | Requires `{"confirm":"CLOSE_ALL"}` |
| `GET` | `/api/positions` | Exchange positions + open trade rows |
| `POST` | `/api/positions/:symbol/close` | Close one symbol |
| `GET`/`PUT` | `/api/circuit-breaker` | Config + live state |
| `GET` | `/api/intel` | Regime, sentiment, funding, correlation snapshot |
| `PUT` | `/api/intel/settings` | Toggle regime/conviction/correlation filters |
| `POST` | `/api/circuit-breaker/reset` | Clear a trip |
| `GET`/`POST` | `/api/strategies` | |
| `POST` | `/api/strategies/:id/activate` \| `/backtest` | |
| `GET` | `/api/trades`, `/api/trades/export.csv` | Filter, paginate, search |
| `GET` | `/api/stats`, `/api/stats/symbols`, `/api/equity` | |
| `GET` | `/api/logs`, `/api/audit` | |
| `GET`/`PUT` | `/api/settings/*` | |
| `WS` | `/ws` | Status, positions, signals, trades, logs, breaker, heartbeat |

The emergency stop needs an explicit confirmation field so a stray POST — or a
misrouted fetch during development — cannot flatten a live book.

---

## Status

Working: market intelligence from five free public sources, regime gating,
correlation and consensus guards, conviction scoring, engine lifecycle, all three strategies, the full trade lifecycle
(open → settle → net P&L → analytics), risk gate with instrument-aware sizing,
circuit breaker, trailing stops, backtests against real Bybit candles, SQLite
persistence with additive migrations, trade history with CSV export, live
WebSocket feed, Telegram alerts with a daily summary scheduler, audit log, kill
switch, token auth, and all four screens responsive desktop/mobile with a
high-contrast mode.

Not done yet:

- **Custom strategy sandbox** (above).
- **No multi-user model** — one shared token, no roles.
- **Grid** does not manage resting ladder orders; it enters and exits at market.
- **Partial fills and partial closes** are not modelled: a trade row is all-or-nothing.
- **Backtest sizing does not compound** across symbols within a run.
- The reconciler infers a live close reason from where price landed; it does not
  query which order actually filled.
- **Intelligence weights are unfitted.** No walk-forward validation has been done
  on the conviction model; it is a sanity filter, not a proven edge.
- Free providers are courtesy-rate-limited. Heavy multi-pair use may need caching
  windows widened or a paid feed.
