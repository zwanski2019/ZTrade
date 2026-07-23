import type { IntelSettings, MarketIntel, SymbolIntel } from "@ztrade/shared";
import { defaultIntelSettings } from "@ztrade/shared";
import { getSetting, setSetting } from "../db.js";
import { logger } from "../bus.js";
import type { Candle } from "../exchange/bybit.js";
import { correlation, returns } from "../strategies/indicators.js";
import { classifyRegime } from "./regime.js";
import {
  fetchBinanceFunding,
  fetchBinanceOpenInterest,
  fetchBinanceOpenInterestHistory,
  fetchConsensusPrices,
  fetchFearGreed,
  fetchGlobalMarket,
  fetchLongShortRatio,
} from "./providers.js";

export const INTEL_SETTINGS_KEY = "intel";

/** "BTCUSDT" -> "BTC". Correlation and spot venues key off the base asset. */
export function baseAsset(symbol: string): string {
  return symbol.replace(/(USDT|USDC|USD|PERP)$/g, "");
}

/** Stable key for a symbol pair, so A|B and B|A are the same entry. */
export function correlationKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/**
 * Aggregates free public market data into one snapshot.
 *
 * Refreshed on the engine tick and cached, so the trading loop never waits on
 * a third-party endpoint. Every field is nullable: if a provider is down the
 * corresponding intelligence is simply absent and the engine falls back to
 * price-only behaviour rather than halting.
 */
class MarketIntelligence {
  private snapshot: MarketIntel = {
    at: 0,
    fearGreed: null,
    btcDominance: null,
    totalMarketCapUsd: null,
    marketCapChangePct24h: null,
    symbols: [],
    correlations: {},
    degraded: [],
  };

  get settings(): IntelSettings {
    return { ...defaultIntelSettings, ...getSetting(INTEL_SETTINGS_KEY, defaultIntelSettings) };
  }

  setSettings(next: IntelSettings): void {
    setSetting(INTEL_SETTINGS_KEY, next);
  }

  get current(): MarketIntel {
    return this.snapshot;
  }

  intelFor(symbol: string): SymbolIntel | null {
    return this.snapshot.symbols.find((s) => s.symbol === symbol) ?? null;
  }

  /**
   * Rebuilds the snapshot.
   *
   * `candlesBySymbol` comes from the engine's own exchange calls — regime and
   * correlation are computed from the prices we actually trade on, not from a
   * third party's idea of them.
   */
  async refresh(
    candlesBySymbol: Map<string, Candle[]>,
    marks: Map<string, number>,
  ): Promise<MarketIntel> {
    const degraded: string[] = [];

    const [fng, global] = await Promise.all([
      fetchFearGreed(),
      fetchGlobalMarket(),
    ]);
    if (!fng) degraded.push("fear-greed");
    if (!global) degraded.push("coingecko");

    const symbols = await Promise.all(
      [...candlesBySymbol.entries()].map(([symbol, candles]) =>
        this.buildSymbolIntel(symbol, candles, marks.get(symbol) ?? null, degraded),
      ),
    );

    this.snapshot = {
      at: Date.now(),
      fearGreed: fng ? { value: fng.value, classification: fng.classification } : null,
      btcDominance: global?.btcDominance ?? null,
      totalMarketCapUsd: global?.totalMarketCapUsd ?? null,
      marketCapChangePct24h: global?.marketCapChangePct24h ?? null,
      symbols,
      correlations: buildCorrelations(candlesBySymbol),
      degraded: [...new Set(degraded)],
    };

    return this.snapshot;
  }

  private async buildSymbolIntel(
    symbol: string,
    candles: Candle[],
    mark: number | null,
    degraded: string[],
  ): Promise<SymbolIntel> {
    const bars = candles.map((c) => ({ high: c.high, low: c.low, close: c.close }));
    const assessment = classifyRegime(bars);

    const base = baseAsset(symbol);

    const [funding, oi, oiHistory, lsr, consensus] = await Promise.all([
      fetchBinanceFunding(symbol),
      fetchBinanceOpenInterest(symbol),
      fetchBinanceOpenInterestHistory(symbol),
      fetchLongShortRatio(symbol),
      fetchConsensusPrices(base),
    ]);

    if (!funding) degraded.push("binance-funding");
    if (consensus.length === 0) degraded.push("consensus-price");

    // Median rather than mean: one bad venue quote cannot drag the reference.
    const consensusPrice = consensus.length > 0 ? median(consensus.map((c) => c.price)) : null;
    const reference = mark ?? candles.at(-1)?.close ?? null;
    const deviationBps =
      consensusPrice !== null && reference !== null && consensusPrice > 0
        ? ((reference - consensusPrice) / consensusPrice) * 10_000
        : null;

    let oiChangePct: number | null = null;
    if (oiHistory && oiHistory.length >= 2) {
      const first = oiHistory[0]!;
      const latest = oiHistory.at(-1)!;
      if (first > 0) oiChangePct = ((latest - first) / first) * 100;
    }

    return {
      symbol,
      regime: assessment.regime,
      adx: assessment.adx,
      volatility: assessment.volatility,
      direction: assessment.direction,
      fundingRate: funding?.fundingRate ?? null,
      openInterest: oi?.openInterest ?? null,
      openInterestChangePct: oiChangePct,
      longShortRatio: lsr,
      consensusPrice,
      consensusDeviationBps: deviationBps,
    };
  }

  /**
   * Highest correlation between `symbol` and anything already held.
   *
   * Three positions in BTC, ETH and SOL is not three positions — those move
   * together, so it is one position at triple size. Without this check the
   * "max open positions" limit silently permits exactly the concentration it
   * was meant to prevent.
   */
  worstCorrelation(
    symbol: string,
    heldSymbols: string[],
  ): { symbol: string; value: number } | null {
    let worst: { symbol: string; value: number } | null = null;

    for (const held of heldSymbols) {
      if (held === symbol) continue;
      const value = this.snapshot.correlations[correlationKey(symbol, held)];
      if (value === undefined) continue;

      if (!worst || Math.abs(value) > Math.abs(worst.value)) {
        worst = { symbol: held, value };
      }
    }

    return worst;
  }

  logDegradation(): void {
    if (this.snapshot.degraded.length === 0) return;
    logger.warn(
      `Market intelligence degraded — unavailable: ${this.snapshot.degraded.join(", ")}. ` +
        "Trading continues on price data alone.",
    );
  }
}

/** Pairwise return correlation across every traded symbol. */
export function buildCorrelations(
  candlesBySymbol: Map<string, Candle[]>,
): Record<string, number> {
  const out: Record<string, number> = {};

  const seriesBySymbol = new Map<string, number[]>();
  for (const [symbol, candles] of candlesBySymbol) {
    if (candles.length < 10) continue;
    seriesBySymbol.set(symbol, returns(candles.map((c) => c.close)));
  }

  const symbols = [...seriesBySymbol.keys()];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const a = symbols[i]!;
      const b = symbols[j]!;
      out[correlationKey(a, b)] = correlation(seriesBySymbol.get(a)!, seriesBySymbol.get(b)!);
    }
  }

  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export const intel = new MarketIntelligence();
