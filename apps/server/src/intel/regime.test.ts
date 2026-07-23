import test from "node:test";
import assert from "node:assert/strict";
import { classifyRegime, regimeAllows, regimeExplanation } from "./regime.ts";
import type { Bar } from "../strategies/indicators.ts";

/** A clean one-directional trend. Starts high enough that a downtrend stays
 *  above zero — real prices never go negative and the helper should not either. */
function trendingBars(count = 120, step = 1): Bar[] {
  const start = step < 0 ? 100 + count * Math.abs(step) * 1.5 : 100;
  return Array.from({ length: count }, (_, i) => {
    const close = start + i * step;
    return { high: close + 0.3, low: close - 0.3, close };
  });
}

/** A tight oscillation with no net progress. */
function rangingBars(count = 120): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + Math.sin(i / 2) * 0.5;
    return { high: close + 0.2, low: close - 0.2, close };
  });
}

/** Wide bars — large true range relative to price. */
function volatileBars(count = 120): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + Math.sin(i / 3) * 8;
    return { high: close + 5, low: close - 5, close };
  });
}

test("a sustained one-way move classifies as TRENDING", () => {
  const result = classifyRegime(trendingBars());
  assert.equal(result.regime, "TRENDING");
  assert.ok(result.adx >= 25, `expected strong ADX, got ${result.adx}`);
  assert.equal(result.direction, 1);
});

test("a downtrend is TRENDING with negative direction", () => {
  const result = classifyRegime(trendingBars(120, -1));
  assert.equal(result.regime, "TRENDING");
  assert.equal(result.direction, -1);
});

test("a tight oscillation classifies as RANGING", () => {
  const result = classifyRegime(rangingBars());
  assert.equal(result.regime, "RANGING");
  assert.ok(result.adx <= 20, `expected weak ADX, got ${result.adx}`);
});

test("wide bars classify as VOLATILE regardless of trend", () => {
  const result = classifyRegime(volatileBars());
  assert.equal(result.regime, "VOLATILE");
  assert.ok(result.volatility >= 0.02);
});

test("insufficient history reports UNKNOWN rather than guessing", () => {
  const result = classifyRegime(trendingBars(5));
  assert.equal(result.regime, "UNKNOWN");
  assert.equal(result.confidence, 0);
});

test("confidence is bounded to 0..1 in every regime", () => {
  for (const bars of [trendingBars(), rangingBars(), volatileBars(), trendingBars(5)]) {
    const { confidence } = classifyRegime(bars);
    assert.ok(confidence >= 0 && confidence <= 1, `confidence out of range: ${confidence}`);
  }
});

// ---------------------------------------------------------------------------
// Strategy gating — the actual point of the classifier
// ---------------------------------------------------------------------------

test("mean reversion is blocked in a trend but momentum is not", () => {
  assert.equal(regimeAllows("MEAN_REVERSION", "TRENDING"), false);
  assert.equal(regimeAllows("MOMENTUM", "TRENDING"), true);
});

test("momentum is blocked in a range but mean reversion is not", () => {
  assert.equal(regimeAllows("MOMENTUM", "RANGING"), false);
  assert.equal(regimeAllows("MEAN_REVERSION", "RANGING"), true);
});

test("grid is blocked during a volatility event", () => {
  assert.equal(regimeAllows("GRID", "VOLATILE"), false);
  assert.equal(regimeAllows("MOMENTUM", "VOLATILE"), true);
});

test("an uncertain regime blocks nothing", () => {
  // Refusing to trade because we cannot classify the market would be worse
  // than trading without the filter at all.
  for (const kind of ["MOMENTUM", "MEAN_REVERSION", "GRID", "CUSTOM"] as const) {
    assert.equal(regimeAllows(kind, "UNKNOWN"), true);
    assert.equal(regimeAllows(kind, "TRANSITIONAL"), true);
  }
});

test("a blocked combination always explains itself", () => {
  assert.match(regimeExplanation("MEAN_REVERSION", "TRENDING"), /trending/i);
  assert.match(regimeExplanation("MOMENTUM", "RANGING"), /ranging/i);
  assert.match(regimeExplanation("GRID", "VOLATILE"), /volatilit/i);
});

test("an allowed combination produces no explanation", () => {
  assert.equal(regimeExplanation("MOMENTUM", "TRENDING"), "");
});
