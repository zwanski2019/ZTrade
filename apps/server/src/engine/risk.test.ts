import test from "node:test";
import assert from "node:assert/strict";
import {
  intendedNotional,
  protectivePrices,
  quantityFor,
  roundToTick,
  trailingStopFor,
} from "./risk.ts";
import { defaultRiskLimits, type RiskLimits } from "@ztrade/shared";

const limits: RiskLimits = { ...defaultRiskLimits };

// ---------------------------------------------------------------------------
// Quantity rounding
// ---------------------------------------------------------------------------

test("quantityFor rounds DOWN to the step size", () => {
  // 100 / 30000 = 0.00333… → must not round up past the approved notional.
  const qty = quantityFor(100, 30_000, 0.001);
  assert.equal(qty, 0.003);
  assert.ok(qty * 30_000 <= 100);
});

test("quantityFor returns zero when the notional cannot buy one step", () => {
  assert.equal(quantityFor(1, 100_000, 0.001), 0);
});

test("quantityFor rejects nonsensical inputs instead of returning NaN", () => {
  assert.equal(quantityFor(100, 0), 0);
  assert.equal(quantityFor(100, 30_000, 0), 0);
  assert.equal(quantityFor(-5, 30_000, 0.001), 0);
  assert.equal(quantityFor(Number.NaN, 30_000, 0.001), 0);
});

test("quantityFor does not emit floating point dust", () => {
  const qty = quantityFor(90, 300, 0.1);
  assert.equal(qty, 0.3);
  assert.equal(String(qty), "0.3");
});

test("quantityFor honours per-instrument step sizes", () => {
  // A whole-unit instrument must never produce a fractional quantity.
  assert.equal(quantityFor(1000, 55, 1), 18);
  // A coarse 0.1 step truncates rather than rounding to nearest.
  assert.equal(quantityFor(100, 55, 0.1), 1.8);
});

// ---------------------------------------------------------------------------
// Tick rounding
// ---------------------------------------------------------------------------

test("roundToTick snaps prices to the instrument tick", () => {
  assert.equal(roundToTick(43_210.567, 0.1), 43_210.6);
  assert.equal(roundToTick(43_210.44, 0.5), 43_210.5);
  assert.equal(roundToTick(1.23456, 0.0001), 1.2346);
});

test("roundToTick leaves prices alone when the tick is unknown", () => {
  assert.equal(roundToTick(123.456, 0), 123.456);
});

// ---------------------------------------------------------------------------
// Protective prices
// ---------------------------------------------------------------------------

test("protectivePrices brackets a LONG correctly", () => {
  const { stopLoss, takeProfit } = protectivePrices(100, "LONG", limits);
  assert.equal(stopLoss, 98);
  assert.equal(takeProfit, 104);
});

test("protectivePrices inverts for a SHORT", () => {
  const { stopLoss, takeProfit } = protectivePrices(100, "SHORT", limits);
  assert.equal(stopLoss, 102);
  assert.equal(takeProfit, 96);
});

test("stop is always on the losing side of entry", () => {
  for (const side of ["LONG", "SHORT"] as const) {
    const { stopLoss, takeProfit } = protectivePrices(250, side, limits);
    if (side === "LONG") {
      assert.ok(stopLoss < 250 && takeProfit > 250);
    } else {
      assert.ok(stopLoss > 250 && takeProfit < 250);
    }
  }
});

// ---------------------------------------------------------------------------
// Position sizing
// ---------------------------------------------------------------------------

test("FIXED_NOTIONAL ignores equity entirely", () => {
  const cfg: RiskLimits = { ...limits, sizingMode: "FIXED_NOTIONAL", maxPositionSize: 250 };
  assert.equal(intendedNotional(cfg, 10_000), 250);
  assert.equal(intendedNotional(cfg, 1_000_000), 250);
});

test("PERCENT_EQUITY scales with the account", () => {
  const cfg: RiskLimits = { ...limits, sizingMode: "PERCENT_EQUITY", equityPct: 10 };
  assert.equal(intendedNotional(cfg, 10_000), 1_000);
  assert.equal(intendedNotional(cfg, 500), 50);
});

test("PERCENT_EQUITY falls back to the fixed size when equity is unknown", () => {
  const cfg: RiskLimits = {
    ...limits,
    sizingMode: "PERCENT_EQUITY",
    equityPct: 10,
    maxPositionSize: 77,
  };
  assert.equal(intendedNotional(cfg, 0), 77);
});

test("RISK_BASED keeps money-at-risk constant as the stop tightens", () => {
  const wide: RiskLimits = {
    ...limits,
    sizingMode: "RISK_BASED",
    riskPerTradePct: 1,
    stopLossPct: 2,
  };
  const tight: RiskLimits = { ...wide, stopLossPct: 1 };

  const equity = 10_000;
  const wideNotional = intendedNotional(wide, equity);
  const tightNotional = intendedNotional(tight, equity);

  // Halving the stop distance must double the position...
  assert.equal(wideNotional, 5_000);
  assert.equal(tightNotional, 10_000);
  // ...so that the loss at the stop is identical either way: 1% of equity.
  assert.equal(wideNotional * 0.02, 100);
  assert.equal(tightNotional * 0.01, 100);
});

test("RISK_BASED degrades safely without equity or a stop", () => {
  const cfg: RiskLimits = {
    ...limits,
    sizingMode: "RISK_BASED",
    maxPositionSize: 42,
    stopLossPct: 0.0001,
  };
  assert.equal(intendedNotional(cfg, 0), 42);
});

// ---------------------------------------------------------------------------
// Trailing stops
// ---------------------------------------------------------------------------

test("trailing stop initialises below the mark for a LONG", () => {
  assert.equal(trailingStopFor("LONG", 100, null, 5), 95);
});

test("trailing stop initialises above the mark for a SHORT", () => {
  assert.equal(trailingStopFor("SHORT", 100, null, 5), 105);
});

test("trailing stop ratchets up for a LONG but never down", () => {
  // Price rose to 120 → stop should move up to 114.
  assert.equal(trailingStopFor("LONG", 120, 95, 5), 114);
  // Price fell back to 100 → 95 is still the better stop, so do not move.
  assert.equal(trailingStopFor("LONG", 100, 114, 5), null);
});

test("trailing stop ratchets down for a SHORT but never up", () => {
  assert.equal(trailingStopFor("SHORT", 80, 105, 5), 84);
  assert.equal(trailingStopFor("SHORT", 100, 84, 5), null);
});

test("trailing stop is disabled at zero percent", () => {
  assert.equal(trailingStopFor("LONG", 100, null, 0), null);
});
