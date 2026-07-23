import type { ConvictionInput, ConvictionScore } from "@ztrade/shared";

/**
 * Composite conviction scoring.
 *
 * A single indicator crossing is a weak reason to commit money. This folds the
 * strategy's own signal together with independent context — regime, crowd
 * positioning, sentiment, cross-venue agreement — into one score that both
 * gates the entry and scales the size.
 *
 * Everything here is a PURE function of its inputs so the weighting can be
 * tested and argued about directly, rather than being buried in the engine.
 *
 * Honest limits: these weights are reasoned defaults, not fitted parameters.
 * Sentiment and funding are slow, noisy inputs that matter mainly at extremes.
 * Treat the score as a filter against obviously-bad entries, not as alpha.
 */

/** Contribution weights. They sum to 1 so the result stays in 0..1. */
export const WEIGHTS = {
  signal: 0.45,
  regime: 0.2,
  funding: 0.15,
  sentiment: 0.1,
  openInterest: 0.1,
} as const;

/** Below this the entry is skipped entirely. */
export const MIN_CONVICTION = 0.45;

/** Funding beyond this per-interval rate counts as a crowded book. */
export const FUNDING_EXTREME = 0.0005; // 0.05% per 8h ≈ 0.15%/day

export function scoreConviction(input: ConvictionInput): ConvictionScore {
  const reasons: string[] = [];
  const wantsLong = input.action === "BUY";

  // --- The strategy's own confidence ---------------------------------------
  const signalScore = clamp01(input.signalConfidence);

  // --- Regime agreement ----------------------------------------------------
  // A trend in the direction we want to trade is supportive; against us it is
  // a warning even when the regime does not outright block the strategy.
  let regimeScore = 0.5;
  if (input.regime === "TRENDING") {
    const aligned = wantsLong ? input.regimeDirection > 0 : input.regimeDirection < 0;
    regimeScore = aligned ? 0.9 : 0.15;
    reasons.push(aligned ? "trend aligned" : "trading against the trend");
  } else if (input.regime === "RANGING") {
    regimeScore = 0.6;
  } else if (input.regime === "VOLATILE") {
    regimeScore = 0.3;
    reasons.push("elevated volatility");
  }

  // --- Funding rate (crowd positioning) ------------------------------------
  // Positive funding means longs are paying shorts: the book is long-heavy.
  // Joining a crowded side is penalised; taking the other side is rewarded.
  let fundingScore = 0.5;
  if (input.fundingRate !== null) {
    const crowdedLong = input.fundingRate > FUNDING_EXTREME;
    const crowdedShort = input.fundingRate < -FUNDING_EXTREME;

    if (crowdedLong) {
      fundingScore = wantsLong ? 0.2 : 0.85;
      reasons.push(wantsLong ? "buying into crowded longs" : "fading crowded longs");
    } else if (crowdedShort) {
      fundingScore = wantsLong ? 0.85 : 0.2;
      reasons.push(wantsLong ? "fading crowded shorts" : "selling into crowded shorts");
    }
  }

  // --- Sentiment (Fear & Greed), contrarian at the extremes ----------------
  let sentimentScore = 0.5;
  if (input.fearGreed !== null) {
    if (input.fearGreed <= 25) {
      sentimentScore = wantsLong ? 0.8 : 0.3;
      reasons.push("extreme fear");
    } else if (input.fearGreed >= 75) {
      sentimentScore = wantsLong ? 0.3 : 0.8;
      reasons.push("extreme greed");
    }
  }

  // --- Open interest trend -------------------------------------------------
  // Rising OI means new money is entering and the move has backing. Falling OI
  // on a move is position-closing — a squeeze, which tends not to continue.
  let oiScore = 0.5;
  if (input.openInterestChangePct !== null) {
    if (input.openInterestChangePct > 1) {
      oiScore = 0.75;
      reasons.push("open interest rising");
    } else if (input.openInterestChangePct < -1) {
      oiScore = 0.35;
      reasons.push("open interest falling");
    }
  }

  const score =
    signalScore * WEIGHTS.signal +
    regimeScore * WEIGHTS.regime +
    fundingScore * WEIGHTS.funding +
    sentimentScore * WEIGHTS.sentiment +
    oiScore * WEIGHTS.openInterest;

  return {
    score: clamp01(score),
    passed: score >= MIN_CONVICTION,
    reasons,
    components: {
      signal: signalScore,
      regime: regimeScore,
      funding: fundingScore,
      sentiment: sentimentScore,
      openInterest: oiScore,
    },
  };
}

/**
 * Scales position size by conviction.
 *
 * Deliberately bounded to 0.5x-1.0x of the risk-approved size. Conviction may
 * shrink a position but must NEVER grow one beyond what the risk limits
 * approved — otherwise a confident-looking score could quietly breach the
 * ceiling the operator set.
 */
export function sizeMultiplier(score: number): number {
  const normalised = (clamp01(score) - MIN_CONVICTION) / (1 - MIN_CONVICTION);
  return 0.5 + clamp01(normalised) * 0.5;
}

/**
 * Volatility-adjusted stop distance, in percent.
 *
 * A fixed 2% stop is too tight in a volatile market (stopped out by noise) and
 * needlessly wide in a calm one. Anchoring to ATR makes the stop mean the same
 * thing — "the move went genuinely against me" — in both.
 */
export function volatilityStopPct(
  atrFraction: number,
  multiplier: number,
  fallbackPct: number,
): number {
  if (!Number.isFinite(atrFraction) || atrFraction <= 0) return fallbackPct;

  const pct = atrFraction * 100 * multiplier;
  // Clamp hard: a bad ATR reading must not produce a 0.01% or a 50% stop.
  return Math.max(0.2, Math.min(20, pct));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
