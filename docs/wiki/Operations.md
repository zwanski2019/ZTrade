# Operations

## Running

```bash
pnpm dev            # development, both apps
pnpm --filter @ztrade/server start   # server only
```

Bind to `127.0.0.1`. There is no multi-user model — the API token is a single
shared credential.

## What to watch

### Ingestion health

`GET /api/marketdata` → `ingestion`:

| Field | Healthy | Meaning if not |
| :-- | :-- | :-- |
| `invalid` | `0` | The venue changed a payload shape, or something is corrupting messages |
| `gaps` | low | Network loss. Each gap forces a book rebuild |
| `staleBooks` | `0` | A book is not serving prices — the engine is flying blind on that symbol |
| `reconnects` | low | Connection instability |
| `latency.p99` | < ~500 ms | Your fill assumptions in backtests are too optimistic |

**Calibrate the simulator to measured latency.** The default `SimConfig` assumes
50 ms; live p99 is frequently 400 ms+. An optimistic latency assumption is one of
the quieter ways a backtest lies.

### Circuit breaker

`GET /api/circuit-breaker`. If it is `DEGRADED` or `HALT`, find out *why* before
resetting. The breaker tripping is information, not an obstacle.

### Audit log

`GET /api/audit` — engine start/stop, emergency stops, strategy and settings
changes, auth failures, each with a source IP. Survives restarts.

## When things break

### The book goes stale

Expected behaviour: no prices are served, no orders are placed on that symbol,
and the ingestion layer resubscribes to force a fresh snapshot. If it stays
stale, the WebSocket is not recovering — restart ingestion.

### The engine will not start

- *"No strategy is armed"* — arming is deliberately explicit
- *"Bybit rejected the configured API credentials"* — wrong key, wrong network,
  or an IP whitelist that no longer matches
- *"Cannot reach Bybit"* — network or venue outage

### An order was rejected

Check the skip reason in the Signal Feed. Common causes:

| Reason | Meaning |
| :-- | :-- |
| Below exchange minimum | Size rounds under `minOrderQty` or `minNotional` |
| Correlation limit | Already holding something that moves the same way |
| Regime blocked | Strategy kind does not suit current conditions |
| Consensus deviation | Our price disagrees with other venues — feed suspect |
| Daily cap reached | `maxTradesPerDay` |

### You need to be flat, now

```bash
curl -X POST http://127.0.0.1:8788/api/engine/emergency-stop \
  -H "Authorization: Bearer $ZTRADE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"CLOSE_ALL"}'
```

If the server is wedged and does not answer, use the **kill switch** on its own
port — that is exactly what it exists for.

## Backups

The SQLite database at `DATABASE_PATH` holds your trade history. It is
gitignored. Back it up — it is the only record of what the bot actually did, and
the audit chain in it is your forensic trail.

## Upgrading

```bash
git pull
pnpm install
pnpm typecheck && pnpm test
pnpm gate:parity
```

Database migrations are **additive only** — an existing trade database is real
history and is never dropped to accommodate a schema change.
