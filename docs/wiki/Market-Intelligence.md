# Market Intelligence

A context layer built entirely on **free, key-free public APIs**. Every provider
is optional: if one is unreachable that intelligence is simply absent and the
engine keeps trading on price alone. Failures never throw, results are cached,
and stale data is served in preference to nothing.

## Sources

| Source | Provides | Cost |
| :-- | :-- | :-- |
| alternative.me | Crypto Fear & Greed index | free, no key |
| Binance futures (public) | Funding rate, open interest + history, long/short ratio | free, no key |
| CoinGecko (public) | BTC dominance, total market cap, 24h change | free, no key |
| Coinbase + Kraken (public) | Independent spot prices for consensus | free, no key |
| Bybit klines | Regime, volatility, correlation — from prices we actually trade | free |

## What it does

### Regime classification

ADX + ATR label the market and gate which strategies may run. See
[Strategies](Strategies#regime-gating).

### Correlation guard

Three positions in BTC, ETH and SOL is **not** three positions. On real mainnet
5-minute data those pairs correlate at **0.81–0.89** — so without this check the
"max open positions" limit silently permits exactly the concentration it was
meant to prevent.

Correlation is computed on **returns**, not prices: two assets that both drift
upward have a high price correlation almost by construction, which tells you
nothing about whether they move together day to day.

Absolute value is used — a −0.9 correlation held short is the same concentration
as +0.9 held long.

### Cross-venue consensus guard

Our price is compared against the **median** of independent venues (median, not
mean, so one bad quote cannot drag the reference).

A large deviation means the feed is stale or the book is broken — precisely when
a bot should stop rather than act. Bybit *testnet* legitimately reads ~75 bps
from mainnet consensus, since it is a separate market.

### Funding as crowd positioning

Positive funding means longs are paying shorts: the book is long-heavy. Joining
a crowded side is penalised; taking the other side is rewarded. Only extremes
count — mild funding does not move the score.

### Conviction scoring

Folds signal confidence, regime agreement, funding, sentiment and open-interest
trend into one 0–1 score that gates entry and scales size.

| Component | Weight |
| :-- | --: |
| Strategy signal | 0.45 |
| Regime agreement | 0.20 |
| Funding | 0.15 |
| Sentiment | 0.10 |
| Open interest | 0.10 |

Size scaling is bounded **0.5×–1.0×**. Conviction may *shrink* a position but
**never** grow it beyond what the risk limits approved — otherwise a
confident-looking score could quietly breach the operator's ceiling.

## Honest limits

- **The weights are reasoned defaults, not fitted parameters.** No walk-forward
  validation has been done.
- Sentiment and funding are slow, noisy inputs that matter mainly at extremes.
- Correlation is backward-looking.
- These are courtesy-rate-limited public endpoints. Heavy multi-pair use needs
  wider cache windows or a paid feed.

Treat the score as a filter against obviously-bad entries, **not as alpha**.
