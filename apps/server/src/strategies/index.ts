import type { StrategyConfig, StrategyKind } from "@ztrade/shared";
import type { Candle } from "../exchange/bybit.js";
import {
  bollinger,
  crossedAbove,
  crossedBelow,
  last,
  macd,
  rsi,
  sma,
} from "./indicators.js";

/** What a strategy decides for one symbol on one candle close. */
export interface Decision {
  action: "BUY" | "SELL" | "HOLD";
  /** Short label shown in the Signal Feed, e.g. "MACD_CROSS". */
  reason: string;
  /** 0..1 — rendered as a percentage next to the signal. */
  confidence: number;
}

export interface Strategy {
  kind: StrategyKind;
  /** Minimum candles required before `evaluate` can return anything but HOLD. */
  warmup: number;
  evaluate(candles: Candle[], config: StrategyConfig): Decision;
}

const HOLD: Decision = { action: "HOLD", reason: "NO_SIGNAL", confidence: 0 };

function num(config: StrategyConfig, key: string, fallback: number): number {
  const value = config.params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Momentum — MACD crossover, confirmed by RSI.
 *
 * A crossover alone is noisy, so RSI must agree with the direction: we don't
 * buy a bullish cross that is already overbought. This is the pairing the
 * dashboard's signal feed shows as MACD_CROSS + RSI CONFIRM.
 */
export const momentumStrategy: Strategy = {
  kind: "MOMENTUM",
  warmup: 60,

  evaluate(candles, config) {
    const closes = candles.map((c) => c.close);
    const fastPeriod = num(config, "fastPeriod", 12);
    const slowPeriod = num(config, "slowPeriod", 26);
    const signalPeriod = num(config, "signalPeriod", 9);
    const rsiPeriod = num(config, "rsiPeriod", 14);
    const rsiUpper = num(config, "rsiUpper", 70);
    const rsiLower = num(config, "rsiLower", 30);

    if (closes.length < slowPeriod + signalPeriod + 2) return HOLD;

    const { macd: macdLine, signal } = macd(closes, fastPeriod, slowPeriod, signalPeriod);
    const rsiSeries = rsi(closes, rsiPeriod);
    const currentRsi = last(rsiSeries);
    if (currentRsi === undefined || signal.length < 2) return HOLD;

    // Align the MACD line to the signal line before comparing crossovers.
    const alignedMacd = macdLine.slice(macdLine.length - signal.length);

    if (crossedAbove(alignedMacd, signal)) {
      if (currentRsi >= rsiUpper) {
        // Bullish cross into overbought — the move is likely already spent.
        return { action: "HOLD", reason: "CROSS_BUT_OVERBOUGHT", confidence: 0 };
      }
      // Confidence scales with how much room is left before overbought.
      const headroom = (rsiUpper - currentRsi) / (rsiUpper - rsiLower);
      return {
        action: "BUY",
        reason: currentRsi > 50 ? "MACD_CROSS" : "RSI CONFIRM",
        confidence: Math.min(0.95, 0.5 + headroom * 0.45),
      };
    }

    if (crossedBelow(alignedMacd, signal)) {
      if (currentRsi <= rsiLower) {
        return { action: "HOLD", reason: "CROSS_BUT_OVERSOLD", confidence: 0 };
      }
      const headroom = (currentRsi - rsiLower) / (rsiUpper - rsiLower);
      return {
        action: "SELL",
        reason: currentRsi < 50 ? "MACD_CROSS" : "RSI CONFIRM",
        confidence: Math.min(0.95, 0.5 + headroom * 0.45),
      };
    }

    return HOLD;
  },
};

/**
 * Mean reversion — fade moves that pierce a Bollinger band while RSI is at an
 * extreme. Produces the OVERBOUGHT / OVERSOLD signals in the feed.
 */
export const meanReversionStrategy: Strategy = {
  kind: "MEAN_REVERSION",
  warmup: 40,

  evaluate(candles, config) {
    const closes = candles.map((c) => c.close);
    const period = num(config, "period", 20);
    const mult = num(config, "stdDev", 2);
    const rsiPeriod = num(config, "rsiPeriod", 14);
    const rsiUpper = num(config, "rsiUpper", 70);
    const rsiLower = num(config, "rsiLower", 30);

    if (closes.length < period + rsiPeriod + 2) return HOLD;

    const bands = bollinger(closes, period, mult);
    const rsiSeries = rsi(closes, rsiPeriod);
    const price = last(closes);
    const upper = last(bands.upper);
    const lower = last(bands.lower);
    const currentRsi = last(rsiSeries);

    if (
      price === undefined ||
      upper === undefined ||
      lower === undefined ||
      currentRsi === undefined
    ) {
      return HOLD;
    }

    if (price >= upper && currentRsi >= rsiUpper) {
      // How far past the band we are, capped so a single spike can't claim 100%.
      const excess = Math.min(1, (price - upper) / Math.max(upper * 0.01, 1e-9));
      return {
        action: "SELL",
        reason: "OVERBOUGHT",
        confidence: Math.min(0.95, 0.55 + excess * 0.4),
      };
    }

    if (price <= lower && currentRsi <= rsiLower) {
      const excess = Math.min(1, (lower - price) / Math.max(lower * 0.01, 1e-9));
      return {
        action: "BUY",
        reason: "OVERSOLD",
        confidence: Math.min(0.95, 0.55 + excess * 0.4),
      };
    }

    return HOLD;
  },
};

/**
 * Grid — buy each time price drops a step below the rolling mean, sell each
 * time it rises a step above. Intentionally simple: a full grid needs resting
 * ladder orders, which this engine does not manage yet.
 */
export const gridStrategy: Strategy = {
  kind: "GRID",
  warmup: 30,

  evaluate(candles, config) {
    const closes = candles.map((c) => c.close);
    const period = num(config, "period", 20);
    const stepPct = num(config, "gridStepPct", 1) / 100;

    if (closes.length < period + 1) return HOLD;

    const mean = last(sma(closes, period));
    const price = last(closes);
    if (mean === undefined || price === undefined || mean === 0) return HOLD;

    const deviation = (price - mean) / mean;
    const steps = Math.trunc(Math.abs(deviation) / stepPct);
    if (steps < 1) return HOLD;

    return {
      action: deviation < 0 ? "BUY" : "SELL",
      reason: `GRID_STEP_${steps}`,
      confidence: Math.min(0.9, 0.4 + steps * 0.15),
    };
  },
};

/**
 * Custom — placeholder for the "Custom Script (JS/Python)" option in the UI.
 * It always holds. Executing operator-supplied code needs a real sandbox
 * (worker + resource caps); shipping an eval() here would be a remote code
 * execution hole, so the option stays inert until that exists.
 */
export const customStrategy: Strategy = {
  kind: "CUSTOM",
  warmup: 0,
  evaluate: () => ({
    action: "HOLD",
    reason: "CUSTOM_NOT_IMPLEMENTED",
    confidence: 0,
  }),
};

const registry: Record<StrategyKind, Strategy> = {
  MOMENTUM: momentumStrategy,
  MEAN_REVERSION: meanReversionStrategy,
  GRID: gridStrategy,
  CUSTOM: customStrategy,
};

export function getStrategyImpl(kind: StrategyKind): Strategy {
  return registry[kind];
}
