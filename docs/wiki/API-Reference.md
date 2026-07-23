# API Reference

Base URL: `http://127.0.0.1:8788`

All routes except `/api/health` require:

```
Authorization: Bearer <ZTRADE_API_TOKEN>
```

The WebSocket and CSV export accept `?token=<...>` instead, since neither can
set a header.

## Health & status

| Method | Path | Notes |
| :-- | :-- | :-- |
| `GET` | `/api/health` | **Public.** Liveness only — exposes nothing else |
| `GET` | `/api/status` | Engine state, breaker state, open position count |
| `GET` | `/api/dashboard` | Everything the dashboard needs in one round trip |

## Engine control

| Method | Path | Notes |
| :-- | :-- | :-- |
| `POST` | `/api/engine/start` | `409` if no strategy is armed |
| `POST` | `/api/engine/stop` | Leaves open positions untouched |
| `POST` | `/api/engine/emergency-stop` | Requires `{"confirm":"CLOSE_ALL"}` |

The confirmation field exists so a stray POST — or a misrouted fetch during
development — cannot flatten a live book.

## Positions

| Method | Path |
| :-- | :-- |
| `GET` | `/api/positions` |
| `POST` | `/api/positions/:symbol/close` |

## Circuit breaker

| Method | Path |
| :-- | :-- |
| `GET` | `/api/circuit-breaker` |
| `PUT` | `/api/circuit-breaker` |
| `POST` | `/api/circuit-breaker/reset` |

## Strategies

| Method | Path |
| :-- | :-- |
| `GET` | `/api/strategies` |
| `POST` | `/api/strategies` |
| `GET` | `/api/strategies/:id` |
| `DELETE` | `/api/strategies/:id` |
| `POST` | `/api/strategies/:id/activate` |
| `POST` | `/api/strategies/:id/backtest` |

Only one strategy is armed at a time; activating one disarms the rest.

## Trades & analytics

| Method | Path | Notes |
| :-- | :-- | :-- |
| `GET` | `/api/trades` | `limit`, `offset`, `status`, `search`, `from`, `to` |
| `GET` | `/api/trades/export.csv` | Accepts `?token=` |
| `GET` | `/api/stats` | Win rate, profit factor, Sharpe, expectancy, streaks |
| `GET` | `/api/stats/symbols` | Per-symbol breakdown |
| `GET` | `/api/equity` | Equity curve |

## Market data (read-only)

| Method | Path | Notes |
| :-- | :-- | :-- |
| `GET` | `/api/marketdata` | L2 books, features, ingestion health. `?depth=` |
| `POST` | `/api/marketdata/start` | `{"symbols":["BTCUSDT"]}` |
| `POST` | `/api/marketdata/stop` | |

A stale book returns `book: null`. Render the degraded state — never the last
known prices.

## Market intelligence

| Method | Path |
| :-- | :-- |
| `GET` | `/api/intel` |
| `PUT` | `/api/intel/settings` |

## Logs & audit

| Method | Path |
| :-- | :-- |
| `GET` | `/api/logs` |
| `GET` | `/api/audit` |

## Settings

| Method | Path | Notes |
| :-- | :-- | :-- |
| `GET` | `/api/settings` | Secrets masked |
| `PUT` | `/api/settings/telegram` | Token stored encrypted |
| `PUT` | `/api/settings/ui` | |
| `PUT` | `/api/settings/exchange` | **Always `405`** — see below |
| `POST` | `/api/settings/exchange/test` | |

Exchange credentials are configured via `.env` and require a restart. Accepting
them over HTTP would mean persisting trading keys in SQLite.

## WebSocket

```
ws://127.0.0.1:8788/ws?token=<token>
```

Events: `status`, `account`, `position`, `positions`, `signal`, `trade`, `log`,
`circuitBreaker`, `heartbeat`.

Each connection receives a replay of current state, so the UI renders
immediately. Replayed entries carry stable ids — deduplicate on `id`, or a
reconnect will duplicate your history.

**Close codes:** `1008` unauthorised (do not retry), `4403` origin rejected
(a server misconfiguration — do not discard the token).

## Kill switch

Separate process, separate port.

| Method | Path | Notes |
| :-- | :-- | :-- |
| `GET` | `/health` | **Public** — so a monitor can confirm it is alive without holding the credential that fires it |
| `POST` | `/kill` | Cancel all, then flatten all |
| `POST` | `/rearm` | Re-arm after a trigger |
