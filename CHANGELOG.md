# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-07-23

Advanced systems build: an event-driven spine with parity, risk and safety
gates. Additive — the existing engine is untouched and still runs.

### Added

- **Phase 0 — Spine.** `@ztrade/core` (normalised events, NATS-shaped bus,
  `ReplayClock`, deterministic order identity), `@ztrade/security`
  (hash-chained audit log, two-layer redaction, Bybit v5 signers, dead-man
  payload), `@ztrade/execution` (pure order state machine, engine loop),
  `@ztrade/adapters-sim` (latency, depth, fees, queue position).
- **Phase 1 — Read-only ingestion.** Bybit WS v5 with strict L2 sequence
  continuity, gap recovery via resubscribe, crossed-book detection,
  fail-closed Zod validation, tick-to-bar aggregation and latency percentiles.
  `@ztrade/features` with O(1) incremental rolling features.
- **Phase 3 — Risk and execution shell.** `@ztrade/risk` with all seven §4.4
  checks and a three-state circuit breaker; per-category rate scheduler;
  TWAP, iceberg, post-only re-peg and a slippage guard; an out-of-process kill
  switch on a dedicated worker thread.
- **Ship gates.** `pnpm gate:parity` (backtest/live decision parity) and
  `pnpm gate:secrets` (end-to-end secret leak scan), both wired into CI.
- Live orderbook panel in the terminal UI, with integrity counters.

### Fixed

- `sweepPrice` float dust caused an order sitting *exactly* on the slippage
  limit to be spuriously rejected. Threshold comparisons now route through
  `exceedsLimitBps`.
- `directionalBias` divided by a signed base, inverting the reported trend
  direction for a negative series.

## [0.3.0] — 2026-07-23

### Added

- **Market intelligence** from five free, key-free public sources: Fear & Greed
  (alternative.me), Binance funding / open interest / long-short ratio,
  CoinGecko global market data, and Coinbase + Kraken cross-venue consensus.
- Regime classification (ADX + ATR) gating strategies by market condition.
- Correlation guard — BTC/ETH/SOL correlate 0.81–0.89 on real 5m data, so
  "three positions" is one position at triple size.
- Cross-venue consensus guard, conviction scoring, ATR-based volatility stops.
- Indicators: true range, ATR, ATR%, ADX, directional bias, Pearson correlation.

## [0.2.0] — 2026-07-23

### Added

- Bearer token auth on API and WebSocket, constant-time comparison.
- WebSocket origin checking (browsers do not apply CORS to sockets).
- AES-256-GCM encryption for stored secrets; per-IP rate limiting; Helmet CSP;
  append-only audit log.
- Circuit breaker on daily loss and consecutive-loss streaks.
- Position sizing modes: fixed, percent-equity, risk-based. Trailing stops.

### Fixed

- **Trades never closed.** `pnl` stayed 0 and status stayed `Open` forever, so
  win rate, profit factor and every downstream metric were computed over an
  empty set. Added a reconciler for both live and paper modes.
- Order quantities used a hardcoded `0.001` step for every symbol; real steps
  vary, so orders would have been rejected outright.
- Realised P&L now nets both fees — a trade closed at its entry price is a loss.
- Backtest equity curve accumulated per-symbol then sorted, producing a path
  that jumped backwards in time.

## [0.1.0] — 2026-07-23

### Added

- Initial scaffold from the Stitch designs: Fastify API, execution engine,
  Bybit adapter, SQLite persistence, React + Tailwind terminal UI.
- Momentum, mean-reversion and grid strategies. Backtesting. Telegram alerts.
- Three-switch safety posture: testnet default, mainnet double opt-in, separate
  live-order gate.

[0.4.0]: https://github.com/zwanski2019/ZTrade/releases/tag/v0.4.0
[0.3.0]: https://github.com/zwanski2019/ZTrade/releases/tag/v0.3.0
[0.2.0]: https://github.com/zwanski2019/ZTrade/releases/tag/v0.2.0
[0.1.0]: https://github.com/zwanski2019/ZTrade/releases/tag/v0.1.0
