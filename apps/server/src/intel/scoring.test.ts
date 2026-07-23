import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_CONVICTION,
  scoreConviction,
  sizeMultiplier,
  volatilityStopPct,
} from "./scoring.ts";
import type { ConvictionInput } from "@ztrade/shared";

const neutral: ConvictionInput = {
  action: "BUY",
  signalConfidence: 0.7,
  regime: "TRANSITIONAL",
  regimeDirection: 0,
  fundingRate: null,
  fearGreed: null,
  openInterestChangePct: null,
};

test("the score always lands in 0..1", () => {
  const extremes: ConvictionInput[] = [
    { ...neutral, signalConfidence: 0 },
    { ...neutral, signalConfidence: 1 },
    { ...neutral, signalConfidence: 5 },
    { ...neutral, signalConfidence: Number.NaN },
    { ...neutral, regime: "TRENDING", regimeDirection: 1, fundingRate: -0.01, fearGreed: 5, openInterestChangePct: 50 },
    { ...neutral, regime: "TRENDING", regimeDirection: -1, fundingRate: 0.01, fearGreed: 95, openInterestChangePct: -50 },
  ];

  for (const input of extremes) {
    const { score } = scoreConviction(input);
    assert.ok(score >= 0 && score <= 1, `score out of range: ${score}`);
  }
});

test("trading with the trend scores higher than against it", () => {
  const withTrend = scoreConviction({
    ...neutral,
    regime: "TRENDING",
    regimeDirection: 1,
  });
  const againstTrend = scoreConviction({
    ...neutral,
    regime: "TRENDING",
    regimeDirection: -1,
  });

  assert.ok(withTrend.score > againstTrend.score);
  assert.ok(withTrend.reasons.includes("trend aligned"));
  assert.ok(againstTrend.reasons.includes("trading against the trend"));
});

test("buying into crowded longs is penalised, fading them is rewarded", () => {
  // Positive funding means longs are paying — the book is long-heavy.
  const buying = scoreConviction({ ...neutral, action: "BUY", fundingRate: 0.002 });
  const fading = scoreConviction({ ...neutral, action: "SELL", fundingRate: 0.002 });

  assert.ok(fading.score > buying.score);
  assert.ok(buying.reasons.includes("buying into crowded longs"));
});

test("mild funding does not move the score", () => {
  const mild = scoreConviction({ ...neutral, fundingRate: 0.00001 });
  const none = scoreConviction(neutral);
  assert.equal(mild.score, none.score);
});

test("sentiment is contrarian at the extremes only", () => {
  const fearBuy = scoreConviction({ ...neutral, fearGreed: 10 });
  const greedBuy = scoreConviction({ ...neutral, fearGreed: 90 });
  const middling = scoreConviction({ ...neutral, fearGreed: 50 });

  assert.ok(fearBuy.score > middling.score, "extreme fear should favour buying");
  assert.ok(greedBuy.score < middling.score, "extreme greed should discourage buying");
  assert.equal(middling.score, scoreConviction(neutral).score);
});

test("rising open interest supports the move, falling undermines it", () => {
  const rising = scoreConviction({ ...neutral, openInterestChangePct: 5 });
  const falling = scoreConviction({ ...neutral, openInterestChangePct: -5 });
  assert.ok(rising.score > falling.score);
  assert.ok(rising.reasons.includes("open interest rising"));
});

test("missing data degrades to neutral rather than blocking", () => {
  // Every optional input null: the score must still be driven by the signal
  // and remain usable, because providers go down.
  const result = scoreConviction({ ...neutral, signalConfidence: 0.9 });
  assert.ok(result.score > 0.5);
  assert.equal(result.passed, true);
});

test("a weak signal in a hostile context fails the threshold", () => {
  const result = scoreConviction({
    action: "BUY",
    signalConfidence: 0.2,
    regime: "TRENDING",
    regimeDirection: -1, // trading against the trend
    fundingRate: 0.002, // into crowded longs
    fearGreed: 90, // extreme greed
    openInterestChangePct: -5,
  });

  assert.equal(result.passed, false);
  assert.ok(result.score < MIN_CONVICTION);
});

test("a strong signal in a supportive context passes", () => {
  const result = scoreConviction({
    action: "BUY",
    signalConfidence: 0.9,
    regime: "TRENDING",
    regimeDirection: 1,
    fundingRate: -0.002,
    fearGreed: 15,
    openInterestChangePct: 5,
  });

  assert.equal(result.passed, true);
  assert.ok(result.score > 0.8);
});

// ---------------------------------------------------------------------------
// Size scaling
// ---------------------------------------------------------------------------

test("the size multiplier never exceeds 1", () => {
  // Conviction may shrink a position but must never breach the risk ceiling.
  for (const score of [0, 0.3, MIN_CONVICTION, 0.7, 1, 5, Number.NaN]) {
    const m = sizeMultiplier(score);
    assert.ok(m <= 1, `multiplier ${m} exceeded 1 at score ${score}`);
    assert.ok(m >= 0.5, `multiplier ${m} below floor at score ${score}`);
  }
});

test("the size multiplier rises with conviction", () => {
  assert.ok(sizeMultiplier(1) > sizeMultiplier(0.7));
  assert.ok(sizeMultiplier(0.7) > sizeMultiplier(MIN_CONVICTION));
  assert.equal(sizeMultiplier(1), 1);
});

// ---------------------------------------------------------------------------
// Volatility stops
// ---------------------------------------------------------------------------

test("volatility stops widen with ATR", () => {
  const calm = volatilityStopPct(0.005, 2, 2); // 0.5% ATR
  const wild = volatilityStopPct(0.03, 2, 2); // 3% ATR
  assert.ok(wild > calm);
  assert.equal(calm, 1); // 0.5% * 2
  assert.equal(wild, 6); // 3% * 2
});

test("volatility stops fall back when ATR is unusable", () => {
  assert.equal(volatilityStopPct(0, 2, 2.5), 2.5);
  assert.equal(volatilityStopPct(Number.NaN, 2, 2.5), 2.5);
  assert.equal(volatilityStopPct(-1, 2, 2.5), 2.5);
});

test("volatility stops are clamped to a sane band", () => {
  // A bad ATR reading must not produce a 0.01% or a 50% stop.
  assert.equal(volatilityStopPct(0.00001, 2, 2), 0.2);
  assert.equal(volatilityStopPct(0.9, 2, 2), 20);
});
