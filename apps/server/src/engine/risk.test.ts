import test from "node:test";
import assert from "node:assert/strict";
import { protectivePrices, quantityFor } from "./risk.ts";
import type { RiskLimits } from "@ztrade/shared";

const limits: RiskLimits = {
  maxPositionSize: 100,
  stopLossPct: 2,
  takeProfitPct: 4,
  maxTradesPerDay: 10,
  globalRiskCap: 500,
};

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
});

test("quantityFor does not emit floating point dust", () => {
  const qty = quantityFor(90, 300, 0.1);
  assert.equal(qty, 0.3);
  assert.equal(String(qty), "0.3");
});

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
