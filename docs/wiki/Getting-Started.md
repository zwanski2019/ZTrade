# Getting Started

## Requirements

- **Node ≥ 22**
- **pnpm ≥ 9**
- A Bybit **testnet** account (optional — the engine runs on public data without one)

## Install

```bash
git clone https://github.com/zwanski2019/ZTrade.git
cd ZTrade
pnpm install
cp .env.example .env
```

## Configure

Open `.env`. The defaults are already safe — testnet, paper mode, auth on.

```bash
PORT=8788
HOST=127.0.0.1

# Safety. See the Safety and Risk page before changing either of these.
ZTRADE_NETWORK=TESTNET
ZTRADE_ALLOW_MAINNET=false
ZTRADE_TRADING_ENABLED=false

# Leave blank and one is generated on first run and printed to the console.
ZTRADE_API_TOKEN=

# Optional. Without them the engine runs on public market data only.
BYBIT_API_KEY=
BYBIT_API_SECRET=
```

### Getting testnet keys

1. Go to <https://testnet.bybit.com/app/user/api-management>
2. Create a key with **Trade + Read** permissions only
3. **Never enable withdrawal permission on a bot key**
4. IP-whitelist it if you can

## Run

```bash
pnpm dev      # server on :8788, web on :5173
```

The server prints an API token on first start:

```
  ZTrade API token (generated — set ZTRADE_API_TOKEN to pin it):
    Xk3n...
```

Open <http://localhost:5173>, paste the token, and you are in.

## First trade (paper)

1. **Strategies** → pick or edit one → tick **Arm this strategy** → **Save & Apply**
2. **Dashboard** → **Start Bot**
3. Watch the **Signal Feed**. Signals that do not trade explain *why* — that is
   usually the more useful information.

In paper mode fills are simulated against the real book. Nothing is sent to the
exchange.

## Verify your install

```bash
pnpm typecheck      # must be clean
pnpm test           # 289 tests
pnpm gate:parity    # backtest/live decision parity
pnpm gate:secrets   # no secret reaches a log sink
```

## Troubleshooting

**"Unauthorised" in the UI.** The token is wrong or the server regenerated one.
Check the server console, or pin `ZTRADE_API_TOKEN` in `.env`.

**The socket connects then drops, and you get bounced to login.** Your browser
origin is not in `CORS_ORIGIN`. Loopback aliases (`localhost` ⇄ `127.0.0.1`) are
treated as equivalent, but a different port is not.

**"No strategy is armed."** Arming is deliberately explicit — the seeded default
starts disabled.

**The engine runs but never trades.** Look at the skip reasons in the Signal
Feed. The usual causes are the regime filter, the correlation guard, or a size
below the exchange minimum.
