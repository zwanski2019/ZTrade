import test from "node:test";
import assert from "node:assert/strict";
import { Decimal, dec } from "./decimal.ts";
import {
  grossPnl,
  netPnl,
  notionalOf,
  protectivePrices,
  quantityForNotional,
  roundQtyDown,
  roundTripFees,
  roundToTick,
} from "./money.ts";

// ===========================================================================
// The exact float traps this whole refactor exists to kill
// ===========================================================================

test("0.1 + 0.2 is EXACTLY 0.3 (the canonical float lie)", () => {
  // In floats: 0.1 + 0.2 === 0.30000000000000004
  assert.equal(0.1 + 0.2 === 0.3, false, "float really is broken");
  assert.equal(dec("0.1").add(dec("0.2")).toString(), "0.3");
  assert.equal(dec(0.1).add(dec(0.2)).eq(dec("0.3")), true);
});

test("0.3 rounded to a step of 0.1 is EXACTLY 3 units (the bug we hand-patched)", () => {
  // The float version: Math.floor(0.3 / 0.1) === Math.floor(2.9999...) === 2.
  // That silently dropped a whole step of order size. Decimal cannot.
  assert.equal(Math.floor(0.3 / 0.1), 2, "float floor really drops the step");
  assert.equal(roundQtyDown("0.3", "0.1").toString(), "0.3");
  assert.equal(roundQtyDown(0.3, 0.1).toString(), "0.3");
});

test("price × 0.01 produces no dust", () => {
  // 100.5 * 0.01 in floats is 1.0050000000000001
  assert.equal(notionalOf("100.5", "0.01").toString(), "1.005");
});

test("a chain of additions does not drift (fee accumulation)", () => {
  // Ten 0.1 additions in float: 0.9999999999999999
  let sum = Decimal.zero();
  for (let i = 0; i < 10; i++) sum = sum.add(dec("0.1"));
  assert.equal(sum.toString(), "1");
});

// ===========================================================================
// Decimal core
// ===========================================================================

test("parses and round-trips decimal strings", () => {
  for (const s of ["0", "1", "-1", "0.5", "-0.001", "12345.6789", "1000000"]) {
    assert.equal(dec(s).toString(), s);
  }
});

test("rejects malformed strings and non-finite numbers", () => {
  assert.throws(() => dec("abc"));
  assert.throws(() => dec("1.2.3"));
  assert.throws(() => Decimal.fromNumber(NaN));
  assert.throws(() => Decimal.fromNumber(Infinity));
});

test("multiplication scale is the sum of operand scales, exactly", () => {
  assert.equal(dec("1.11").mul(dec("1.11")).toString(), "1.2321");
  assert.equal(dec("0.001").mul(dec("1000")).toString(), "1");
});

test("subtraction is exact", () => {
  assert.equal(dec("0.3").sub(dec("0.1")).toString(), "0.2");
  assert.equal(dec("1").sub(dec("0.9")).toString(), "0.1");
});

test("comparison needs no epsilon", () => {
  assert.equal(dec("0.1").add(dec("0.2")).eq(dec("0.3")), true);
  assert.equal(dec("0.3").gt(dec("0.29999")), true);
  assert.equal(dec("-1").lt(dec("0")), true);
  assert.equal(dec("2.50").eq(dec("2.5")), true, "trailing zeros do not affect equality");
});

test("division rounds to the requested scale and mode", () => {
  assert.equal(dec("1").div(dec("3"), 4, "DOWN").toString(), "0.3333");
  assert.equal(dec("2").div(dec("3"), 4, "HALF_UP").toString(), "0.6667");
  assert.equal(dec("1").div(dec("8"), 3).toString(), "0.125");
  assert.throws(() => dec("1").div(dec("0"), 2));
});

test("rounding modes behave", () => {
  assert.equal(dec("2.5").roundToScale(0, "HALF_UP").toString(), "3");
  assert.equal(dec("2.5").roundToScale(0, "HALF_EVEN").toString(), "2");
  assert.equal(dec("3.5").roundToScale(0, "HALF_EVEN").toString(), "4");
  assert.equal(dec("2.7").roundToScale(0, "DOWN").toString(), "2");
  assert.equal(dec("-2.7").roundToScale(0, "DOWN").toString(), "-2");
  assert.equal(dec("2.1").roundToScale(0, "CEIL").toString(), "3");
  assert.equal(dec("-2.1").roundToScale(0, "FLOOR").toString(), "-3");
});

test("roundToStep honours varied step sizes exactly", () => {
  assert.equal(roundQtyDown("0.00333", "0.001").toString(), "0.003");
  assert.equal(roundQtyDown("18.7", "1").toString(), "18");
  assert.equal(roundQtyDown("1.85", "0.1").toString(), "1.8");
  assert.equal(roundQtyDown("150.05", "0.01").toString(), "150.05");
});

test("roundToStep rejects a non-positive step", () => {
  assert.throws(() => dec("1").roundToStep(dec("0")));
  assert.throws(() => dec("1").roundToStep(dec("-0.1")));
});

test("toFixed and toNumber for display", () => {
  assert.equal(dec("1.005").toFixed(2), "1.01");
  assert.equal(dec("1").toFixed(3), "1.000");
  assert.equal(dec("0.1").add(dec("0.2")).toNumber(), 0.3);
});

test("PROPERTY: (a/b)*b reconstructs a within the rounding it was given", () => {
  let state = 999 >>> 0;
  const rng = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
  for (let i = 0; i < 300; i++) {
    const a = dec((rng() * 10000).toFixed(4));
    const b = dec((rng() * 100 + 0.01).toFixed(4));
    const q = a.div(b, 12, "DOWN");
    const back = q.mul(b);
    // Truncating division means back <= a, and the gap is under one b at scale.
    assert.ok(back.lte(a), `seed ${i}: (a/b)*b exceeded a`);
    assert.ok(a.sub(back).lt(b), `seed ${i}: reconstruction gap too large`);
  }
});

// ===========================================================================
// Money helpers
// ===========================================================================

test("quantityForNotional sizes and floors to step, exactly", () => {
  // 100 / 30000 = 0.00333… → 0.003 at step 0.001
  assert.equal(quantityForNotional("100", "30000", "0.001").toString(), "0.003");
  // The exact-multiple case that broke the float version.
  assert.equal(quantityForNotional("90", "300", "0.1").toString(), "0.3");
  // whole-unit instrument
  assert.equal(quantityForNotional("1000", "55", "1").toString(), "18");
});

test("quantityForNotional returns zero on degenerate inputs", () => {
  assert.equal(quantityForNotional("100", "0", "0.001").isZero(), true);
  assert.equal(quantityForNotional("0", "100", "0.001").isZero(), true);
  assert.equal(quantityForNotional("1", "100000", "0.001").isZero(), true);
});

test("roundToTick snaps prices exactly", () => {
  assert.equal(roundToTick("43210.567", "0.1").toString(), "43210.6");
  assert.equal(roundToTick("1.23456", "0.0001").toString(), "1.2346");
});

test("grossPnl is exact and side-aware", () => {
  assert.equal(grossPnl("LONG", "2", "100", "110").toString(), "20");
  assert.equal(grossPnl("LONG", "2", "100", "90").toString(), "-20");
  assert.equal(grossPnl("SHORT", "2", "100", "90").toString(), "20");
});

test("fees are charged on entry and exit notional", () => {
  // (100*2 + 110*2) * 0.00055 = 0.231
  assert.equal(roundTripFees("2", "100", "110", "0.00055").toString(), "0.231");
});

test("netPnl subtracts fees exactly, and a flat trade is a loss", () => {
  assert.equal(netPnl("LONG", "1", "100", "110", "0.001").toString(), "9.79");
  // Closing at the entry price loses the round-trip fee.
  assert.equal(netPnl("LONG", "1", "100", "100", "0.001").sign(), -1);
  assert.equal(netPnl("LONG", "1", "100", "100", "0.001").toString(), "-0.2");
});

test("protectivePrices bracket entry exactly", () => {
  const long = protectivePrices("100", "LONG", "2", "4");
  assert.equal(long.stopLoss.toString(), "98");
  assert.equal(long.takeProfit.toString(), "104");

  const short = protectivePrices("100", "SHORT", "2", "4");
  assert.equal(short.stopLoss.toString(), "102");
  assert.equal(short.takeProfit.toString(), "96");
});
