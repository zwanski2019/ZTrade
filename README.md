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
| `ZTRADE_TRADING_ENABLED` | `false` | Paper mode: strategies run and signals are recorded, but **no order is ever sent** |

So a fresh checkout runs on testnet, in paper mode, and refuses to touch real
funds even if `ZTRADE_NETWORK=MAINNET` is set by accident. Reaching real money
takes two deliberate, separate edits.

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

Open <http://localhost:5173>. With no API keys configured the engine still runs
on public market data — you get live signals, backtests and the full UI, just no
account balance or positions.

Then: **Strategies → arm one → Dashboard → Start Bot.**

### Individually

```bash
pnpm dev:server
pnpm dev:web
pnpm test        # server unit tests
pnpm typecheck
pnpm build
```

---

## How it works

**Execution engine** (`apps/server/src/engine/engine.ts`) is a state machine —
`STOPPED → STARTING → RUNNING → STOPPING`, plus `ERROR`. While running it:

- pings Bybit every 5s for the heartbeat and latency readout,
- every 15s pulls candles for each allowed pair and evaluates the armed strategy,
- records every signal, and opens a position when the signal clears risk checks,
- pushes everything to the browser over one WebSocket.

**Only one strategy is armed at a time**, matching the dashboard's single
"Active Strategy" slot. Arming is explicit — the seeded default starts disabled.

**Risk** (`engine/risk.ts`) is the single choke point before any order. It
enforces the daily trade cap, one-position-per-symbol, the allowed-pairs list,
and the global risk cap, then clamps size to whichever ceiling binds first.
Quantities always round **down** to the step size — rounding up could exceed the
limit that was just approved.

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
close with no slippage, and a candle that spans both stop and target counts as a
stop. Both choices make results *pessimistic* on exits but *optimistic* on
entries — treat them as bounds, not forecasts.

---

## Configuration

All via `.env` — see [`.env.example`](.env.example).

Exchange credentials are read at startup and are **deliberately not editable
from the browser**. `PUT /api/settings/exchange` returns `405` by design:
accepting trading keys over HTTP and persisting them in SQLite is not worth the
convenience. The API only ever returns a masked key and a `hasSecret` boolean.

---

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | |
| `GET` | `/api/dashboard` | Everything the dashboard needs in one round trip |
| `GET` | `/api/status` | Engine state |
| `POST` | `/api/engine/start` \| `/stop` | |
| `POST` | `/api/engine/emergency-stop` | Requires `{"confirm":"CLOSE_ALL"}` |
| `GET`/`POST` | `/api/strategies` | |
| `POST` | `/api/strategies/:id/activate` | Arms it (disarms all others) |
| `POST` | `/api/strategies/:id/backtest` | |
| `GET` | `/api/trades` | Filter, paginate, search |
| `GET` | `/api/trades/export.csv` | |
| `GET` | `/api/stats`, `/api/equity`, `/api/logs` | |
| `GET`/`PUT` | `/api/settings/*` | |
| `WS` | `/ws` | Live status, signals, trades, logs, heartbeat |

The emergency stop needs an explicit confirmation field so a stray POST — or a
misrouted fetch during development — cannot flatten a live book.

---

## Status

Working: engine lifecycle, all three strategies, risk gate, backtests against
real Bybit candles, SQLite persistence, trade history with CSV export, live
WebSocket feed, Telegram alerts, kill switch, and all four screens responsive
desktop/mobile with a high-contrast mode.

Not done yet:

- **Position close tracking.** Positions are opened by the engine and protected
  by exchange-side SL/TP, but nothing yet reconciles a close back into the trade
  row — so `pnl` stays 0 and status stays `Open` until that lands. This is the
  most important gap.
- Custom strategy sandbox (above).
- No auth on the API. Bind to `127.0.0.1` only; do not expose it.
- Grid strategy does not manage resting ladder orders.
- Daily summary Telegram notification is a stored toggle with no scheduler.
