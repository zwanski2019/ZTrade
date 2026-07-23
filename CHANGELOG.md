# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — 2026-07-23

The Security Plane — ZTrade's wedge. A security-first algorithmic trading
framework built by an offensive-security researcher, for people who understand a
trading bot is a credentialed, money-moving target.

### Added

- **`Secret<T>`** — structural redaction as a TYPE, not developer discipline.
  Every serialisation path a logger can reach (toString, toJSON, util.inspect,
  primitive coercion) returns `[REDACTED]`; the plaintext is reachable only via
  an explicit `.expose()`. Property-tested over 500 fuzzed serialisations, zero
  leaks.
- **Key-scope enforcement** — the bot queries its own API key's permissions and
  REFUSES to start if withdrawal is enabled. A compromise of a withdrawal key is
  a drained account, not a bad trade. Wired into the live broker's
  `verifyKeyScope()`.
- **Signal authentication** — HMAC-SHA256 + nonce replay protection for external
  signals (webhooks). Unsigned, tampered, stale, future-dated, or replayed
  signals are rejected; a forged signal never burns a legitimate nonce.
- **The self-red-team suite** (`security-tests/`) — ships the exploits ZTrade
  defends against and proves in CI that the defence holds. Nine attacks:
  exfiltration, withdrawal key, forged/replayed/tampered webhook, clock skew,
  nonce exhaustion, timing. **A failure blocks the build.**
- **`ztrade doctor`** — a first-run security self-audit: key scope, network
  exposure, clock skew, plaintext secrets, dependency surface.
- **`docs/THREAT_MODEL.md`** and **`docs/SECURITY_TESTS.md`** — the public threat
  model and per-attack control mapping.

### Verified

- 399 tests across 12 packages; the self-red-team suite green; parity and secret
  gates green; typecheck clean; web builds.

### Positioning

ZTrade is not "a bot that trades on Bybit." It is an open-source, security-first
algorithmic trading framework. The moat is the Security Plane; everything else is
table stakes. No profit claims, ever.

## [0.6.0] — 2026-07-23

Phase 4 — the live path goes real. Closes ship gates #2 and #6, leaving all
seven green in code.

### Added

- **Private WebSocket account stream** (`@ztrade/adapters-bybit`). Authenticates,
  arms the dead-man's switch, then subscribes — in that exact order, because the
  arming must be in place before any fill can occur. Re-arms on every reconnect,
  since the venue tied the previous arming to the connection that dropped. A
  rejected auth does not spin-retry. **Gate #2.**
- **Durable journal + cold-start recovery** (`@ztrade/execution`). Every account
  event is written to JSONL synchronously before the broker sees it. On restart,
  the journal is replayed through the identical order-state machine, reconciled
  against the venue, and trading stays OFF until reconciled — a recovery gate
  that fails closed. A torn final line from a killed write is skipped, not fatal.
  **Gate #6.**
- **Live pipeline** assembling broker + private WS + journal + reconciler + engine
  into a system that runs against testnet, with periodic reconciliation that
  corrects position drift toward the exchange.

### Verified

- The private WS connect/auth sequence was run against **real Bybit testnet**:
  the socket connected, sent a well-formed auth frame, and received the venue's
  genuine rejection ("API key is invalid") — proving everything up to the point
  real keys take over, and that a rejection does not arm the switch or spin.
- 352 tests across 11 packages; parity and secret gates green.

### Fixed

- The private WS spun on a rejected auth (close → reconnect → re-reject). It now
  stays ERROR and waits for an operator restart.

## [0.5.0] — 2026-07-23

### Added

- **`@ztrade/adapters-bybit` — the live broker.** Implements the same `Broker`
  interface the sim adapter does, so backtest, paper and live now genuinely
  drive the identical engine. Bybit v5 REST with request signing, deterministic
  `orderLinkId` passthrough for idempotency (a timeout-and-retry is rejected as
  a duplicate, never double-filled), and account-event translation that turns
  private-stream messages into order-state transitions. Order truth comes only
  from the execution stream, never from a REST 200.
- **Reconciliation loop** (`reconcile()` in `@ztrade/execution`). Periodically
  diffs local order and position state against the exchange and resolves
  disagreements toward the venue. Catches the dropped WebSocket messages that
  would otherwise leave risk sizing against a position the engine does not
  really hold. Progress toward ship gate #6.
- **Two reference strategies:** Donchian breakout (trend-following) and
  volume-weighted VWAP mean reversion (counter-trend), both pure and
  replay-deterministic, giving the regime filter genuinely opposed logic to
  arbitrate between.

### Verified

- Live signing proven against real Bybit **testnet** (read-only round trip).
- 323 tests across 11 packages; parity and secret gates green.

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

[0.7.0]: https://github.com/zwanski2019/ZTrade/releases/tag/v0.7.0
[0.6.0]: https://github.com/zwanski2019/ZTrade/releases/tag/v0.6.0
[0.5.0]: https://github.com/zwanski2019/ZTrade/releases/tag/v0.5.0
[0.4.0]: https://github.com/zwanski2019/ZTrade/releases/tag/v0.4.0
[0.3.0]: https://github.com/zwanski2019/ZTrade/releases/tag/v0.3.0
[0.2.0]: https://github.com/zwanski2019/ZTrade/releases/tag/v0.2.0
[0.1.0]: https://github.com/zwanski2019/ZTrade/releases/tag/v0.1.0
