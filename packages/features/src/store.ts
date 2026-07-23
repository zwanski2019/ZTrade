import type { MarketEvent, OrderBookSnapshot } from "@ztrade/core";
import { bookImbalance, topOfBook } from "@ztrade/core";
import { Atr, Ema, RealisedVolatility, RollingMean } from "./incremental.ts";

/**
 * Rolling feature store (§4.2).
 *
 * Fed the normalised event stream and nothing else. It performs no I/O, reads
 * no clock, and holds no exchange-specific knowledge — so replaying a tape
 * reproduces every feature value exactly, which is what lets a strategy's
 * inputs be identical in backtest and live.
 */
export interface SymbolFeatures {
  symbol: string;
  /** Last trade price seen. */
  lastPrice: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  atr: number | null;
  /** Annualised realised volatility from log returns. */
  realisedVol: number | null;

  // --- Microstructure, from the book ---
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spreadBps: number | null;
  /** Depth imbalance in [-1, 1]; +1 all bid. */
  imbalance: number | null;
  /**
   * Size-weighted mid. Leans toward the side with less size, which is the
   * side price is more likely to move to — a better short-horizon reference
   * than the plain mid.
   */
  microprice: number | null;

  // --- Order flow, from trades ---
  /** Taker buy volume minus sell volume over the rolling window. */
  flowImbalance: number | null;

  fundingRate: number | null;
  /** True when the book backing these values was healthy. */
  bookFresh: boolean;
  updatedAt: number;
}

interface SymbolState {
  emaFast: Ema;
  emaSlow: Ema;
  atr: Atr;
  vol: RealisedVolatility;
  buyFlow: RollingMean;
  sellFlow: RollingMean;
  features: SymbolFeatures;
}

export interface FeatureConfig {
  emaFastPeriod: number;
  emaSlowPeriod: number;
  atrPeriod: number;
  volPeriod: number;
  flowPeriod: number;
  imbalanceDepth: number;
}

export const DEFAULT_FEATURE_CONFIG: FeatureConfig = {
  emaFastPeriod: 12,
  emaSlowPeriod: 26,
  atrPeriod: 14,
  volPeriod: 60,
  flowPeriod: 50,
  imbalanceDepth: 5,
};

export class FeatureStore {
  private readonly state = new Map<string, SymbolState>();

  constructor(private readonly config: FeatureConfig = DEFAULT_FEATURE_CONFIG) {}

  get(symbol: string): SymbolFeatures | null {
    return this.state.get(symbol)?.features ?? null;
  }

  symbols(): string[] {
    return [...this.state.keys()];
  }

  /** Single entry point. Anything not recognised is ignored, not an error. */
  onEvent(event: MarketEvent): void {
    switch (event.type) {
      case "book":
        return this.onBook(event.symbol, event.book, event.exchangeTs);
      case "trade":
        return this.onTrade(event.symbol, event.price, event.size, event.side, event.exchangeTs);
      case "kline":
        // Only closed bars feed bar-based features. An unconfirmed bar's close
        // can still move, and acting on it is a lookahead bug.
        if (!event.closed) return;
        return this.onBar(event.symbol, event.high, event.low, event.close, event.exchangeTs);
      case "funding": {
        const state = this.ensure(event.symbol);
        state.features.fundingRate = event.rate;
        state.features.updatedAt = event.exchangeTs;
        return;
      }
      case "ticker": {
        const state = this.ensure(event.symbol);
        state.features.lastPrice = event.lastPrice;
        state.features.updatedAt = event.exchangeTs;
        return;
      }
    }
  }

  /**
   * Marks a symbol's book-derived features as unusable.
   *
   * Called when ingestion reports a stale book. The values are blanked rather
   * than left at their last-known figures: a strategy checking `bookFresh`
   * might be correct, but one that forgot to would otherwise quote a spread
   * from a book that stopped updating minutes ago.
   */
  markBookStale(symbol: string): void {
    const state = this.ensure(symbol);
    const f = state.features;
    f.bookFresh = false;
    f.bestBid = null;
    f.bestAsk = null;
    f.mid = null;
    f.spreadBps = null;
    f.imbalance = null;
    f.microprice = null;
  }

  private onBook(symbol: string, book: OrderBookSnapshot, at: number): void {
    const state = this.ensure(symbol);
    const f = state.features;
    const { bid, ask, mid } = topOfBook(book);

    f.bestBid = bid;
    f.bestAsk = ask;
    f.mid = mid;
    f.bookFresh = true;
    f.updatedAt = at;

    f.spreadBps = bid !== null && ask !== null && mid !== null && mid > 0
      ? ((ask - bid) / mid) * 10_000
      : null;

    f.imbalance = bookImbalance(book, this.config.imbalanceDepth);

    const bidSize = book.bids[0]?.size ?? 0;
    const askSize = book.asks[0]?.size ?? 0;
    const totalSize = bidSize + askSize;
    // Weighted toward the thinner side: price moves where there is less to eat.
    f.microprice =
      bid !== null && ask !== null && totalSize > 0
        ? (bid * askSize + ask * bidSize) / totalSize
        : mid;
  }

  private onTrade(
    symbol: string,
    price: number,
    size: number,
    side: "buy" | "sell",
    at: number,
  ): void {
    const state = this.ensure(symbol);

    state.features.lastPrice = price;
    state.features.updatedAt = at;

    state.buyFlow.update(side === "buy" ? size : 0);
    state.sellFlow.update(side === "sell" ? size : 0);

    const buy = state.buyFlow.value;
    const sell = state.sellFlow.value;
    const total = buy + sell;
    state.features.flowImbalance = total > 0 ? (buy - sell) / total : null;

    state.features.realisedVol = state.vol.update(price);
  }

  private onBar(symbol: string, high: number, low: number, close: number, at: number): void {
    const state = this.ensure(symbol);

    state.features.emaFast = state.emaFast.update(close);
    state.features.emaSlow = state.emaSlow.update(close);
    state.features.atr = state.atr.update(high, low, close);
    state.features.updatedAt = at;
  }

  private ensure(symbol: string): SymbolState {
    const existing = this.state.get(symbol);
    if (existing) return existing;

    const created: SymbolState = {
      emaFast: new Ema(this.config.emaFastPeriod),
      emaSlow: new Ema(this.config.emaSlowPeriod),
      atr: new Atr(this.config.atrPeriod),
      vol: new RealisedVolatility(this.config.volPeriod),
      buyFlow: new RollingMean(this.config.flowPeriod),
      sellFlow: new RollingMean(this.config.flowPeriod),
      features: {
        symbol,
        lastPrice: null,
        emaFast: null,
        emaSlow: null,
        atr: null,
        realisedVol: null,
        bestBid: null,
        bestAsk: null,
        mid: null,
        spreadBps: null,
        imbalance: null,
        microprice: null,
        flowImbalance: null,
        fundingRate: null,
        bookFresh: false,
        updatedAt: 0,
      },
    };

    this.state.set(symbol, created);
    return created;
  }

  reset(): void {
    this.state.clear();
  }
}
