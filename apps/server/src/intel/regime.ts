import type { MarketRegime, StrategyKind } from "@ztrade/shared";
import type { Bar } from "../strategies/indicators.ts";
import { adx, atrPercent, directionalBias, last } from "../strategies/indicators.js";

/**
 * Market regime classification.
 *
 * The single highest-value filter in the whole engine. Mean reversion into a
 * strong trend, and momentum in a chop, are the two classic ways an otherwise
 * sound strategy bleeds money. Neither failure is visible to the strategy
 * itself — it only sees its own indicator firing correctly.
 *
 * Thresholds follow Wilder's conventional ADX reading (<20 ranging, >25
 * trending) with the gap between them left deliberately ambiguous rather than
 * forced into a bucket.
 */
export const ADX_RANGING = 20;
export const ADX_TRENDING = 25;
/** ATR above this fraction of price is treated as a volatility event. */
export const ATR_VOLATILE = 0.02;

export interface RegimeAssessment {
  regime: MarketRegime;
  /** Trend strength, 0..100. */
  adx: number;
  /** ATR as a fraction of price. */
  volatility: number;
  /** +1 uptrend, -1 downtrend, 0 sideways. */
  direction: number;
  /** 0..1 — how firmly the inputs support this classification. */
  confidence: number;
}

export function classifyRegime(bars: Bar[], period = 14): RegimeAssessment {
  const adxSeries = adx(bars, period);
  const volSeries = atrPercent(bars, period);

  const adxValue = last(adxSeries) ?? 0;
  const volatility = last(volSeries) ?? 0;
  const direction = directionalBias(bars, period);

  // Not enough history to say anything honest.
  if (adxSeries.length === 0 || volSeries.length === 0) {
    return { regime: "UNKNOWN", adx: 0, volatility: 0, direction: 0, confidence: 0 };
  }

  // Volatility dominates: a violent market is its own regime regardless of
  // whether it happens to be trending, because stops get run either way.
  if (volatility >= ATR_VOLATILE) {
    return {
      regime: "VOLATILE",
      adx: adxValue,
      volatility,
      direction,
      confidence: Math.min(1, volatility / (ATR_VOLATILE * 2)),
    };
  }

  if (adxValue >= ADX_TRENDING) {
    return {
      regime: "TRENDING",
      adx: adxValue,
      volatility,
      direction,
      // Fully confident by ADX 50, which is a genuinely strong trend.
      confidence: Math.min(1, (adxValue - ADX_TRENDING) / 25 + 0.5),
    };
  }

  if (adxValue <= ADX_RANGING) {
    return {
      regime: "RANGING",
      adx: adxValue,
      volatility,
      direction,
      confidence: Math.min(1, (ADX_RANGING - adxValue) / 20 + 0.5),
    };
  }

  // Between the two thresholds: genuinely undecided, and saying so is more
  // useful than picking a side.
  return { regime: "TRANSITIONAL", adx: adxValue, volatility, direction, confidence: 0.3 };
}

/**
 * Whether a strategy kind is appropriate for the current regime.
 *
 * UNKNOWN and TRANSITIONAL permit everything: an uncertain classification is
 * not grounds to block trading, only to avoid claiming an edge.
 */
export function regimeAllows(kind: StrategyKind, regime: MarketRegime): boolean {
  switch (regime) {
    case "TRENDING":
      // Fading a strong trend is the classic account-killer.
      return kind !== "MEAN_REVERSION";

    case "RANGING":
      // Momentum in a chop buys every false breakout.
      return kind !== "MOMENTUM";

    case "VOLATILE":
      // Grid ladders assume an orderly range; a volatility event is neither.
      return kind !== "GRID";

    case "TRANSITIONAL":
    case "UNKNOWN":
    default:
      return true;
  }
}

export function regimeExplanation(kind: StrategyKind, regime: MarketRegime): string {
  if (regimeAllows(kind, regime)) return "";

  switch (regime) {
    case "TRENDING":
      return "Mean reversion is blocked while the market is trending";
    case "RANGING":
      return "Momentum is blocked while the market is ranging";
    case "VOLATILE":
      return "Grid is blocked during a volatility event";
    default:
      return "Blocked by market regime";
  }
}
