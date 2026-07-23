# Disclaimer

**ZTrade places real orders on cryptocurrency derivatives exchanges. You can
lose money with it.**

## Not financial advice

This software is engineering infrastructure. It is not financial advice, not a
recommendation to trade, and not a licensed financial product. Its authors are
not licensed financial advisors.

The bundled strategies are ordinary textbook indicators — MACD, RSI, Bollinger
bands. They are included to exercise the system, not because they are
profitable. No claim of profitability is made or implied.

## Risk of loss

Cryptocurrency derivatives carry a **high risk of loss, including losses
exceeding your deposit**. Leverage amplifies both gains and losses.

Automated systems fail in ways manual trading does not. A software bug, a stale
market data feed, a network partition, or an exchange outage can produce losses
faster than you are able to react — including while you are asleep.

## Backtests are not predictions

Backtest results in this project are **optimistic by construction**. Fills are
modelled at the candle close with no entry slippage model, and the conviction
weights have never been walk-forward validated. Past performance, simulated or
real, does not indicate future results.

## Your responsibility

You are solely responsible for every order this software places on your behalf.

Before running it with real funds you should: run it on testnet for an extended
period, read the code paths that place orders, understand every safety switch,
and use withdrawal-disabled API keys.

## No warranty

Provided "as is", without warranty of any kind. See [LICENSE](LICENSE). The
authors and contributors accept no liability for any loss arising from its use.

## Regulatory

Automated trading may be regulated where you live. Verify your obligations
before use. This project makes no representation that it is lawful or suitable
for use in any particular jurisdiction.
