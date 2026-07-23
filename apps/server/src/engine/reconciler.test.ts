import test from "node:test";
import assert from "node:assert/strict";
import { exitFor, grossPnl, netPnl, roundTripFees } from "./reconciler.ts";

const longTrade = { side: "LONG" as const, size: 2, entryPrice: 100 };
const shortTrade = { side: "SHORT" as const, size: 2, entryPrice: 100 };

// ---------------------------------------------------------------------------
// P&L arithmetic
// ---------------------------------------------------------------------------

test("gross P&L is positive when a LONG rises", () => {
  assert.equal(grossPnl(longTrade, 110), 20);
});

test("gross P&L is negative when a LONG falls", () => {
  assert.equal(grossPnl(longTrade, 90), -20);
});

test("gross P&L inverts for a SHORT", () => {
  assert.equal(grossPnl(shortTrade, 90), 20);
  assert.equal(grossPnl(shortTrade, 110), -20);
});

test("fees are charged on both entry and exit notional", () => {
  // (100*2 + 110*2) * 0.001 = 0.42
  assert.equal(roundTripFees(longTrade, 110, 0.001), 0.42);
});

test("net P&L subtracts fees from gross", () => {
  const net = netPnl(longTrade, 110, 0.001);
  assert.equal(net, 20 - 0.42);
});

test("a flat trade still loses money once fees are applied", () => {
  // Closing at the entry price is a LOSS, because you paid to get in and out.
  const net = netPnl(longTrade, 100, 0.001);
  assert.ok(net < 0, `expected a loss, got ${net}`);
  assert.equal(net, -0.4);
});

// ---------------------------------------------------------------------------
// Exit detection
// ---------------------------------------------------------------------------

const bracketedLong = { side: "LONG" as const, stopLoss: 95, takeProfit: 110 };
const bracketedShort = { side: "SHORT" as const, stopLoss: 105, takeProfit: 90 };

test("no exit while price sits between the stop and the target", () => {
  assert.equal(exitFor(bracketedLong, 100), null);
  assert.equal(exitFor(bracketedShort, 100), null);
});

test("LONG stops out at or below the stop", () => {
  assert.deepEqual(exitFor(bracketedLong, 95), { price: 95, reason: "STOP_LOSS" });
  assert.deepEqual(exitFor(bracketedLong, 90), { price: 95, reason: "STOP_LOSS" });
});

test("LONG takes profit at or above the target", () => {
  assert.deepEqual(exitFor(bracketedLong, 110), { price: 110, reason: "TAKE_PROFIT" });
  assert.deepEqual(exitFor(bracketedLong, 130), { price: 110, reason: "TAKE_PROFIT" });
});

test("SHORT stops out at or above the stop", () => {
  assert.deepEqual(exitFor(bracketedShort, 105), { price: 105, reason: "STOP_LOSS" });
});

test("SHORT takes profit at or below the target", () => {
  assert.deepEqual(exitFor(bracketedShort, 90), { price: 90, reason: "TAKE_PROFIT" });
});

test("the stop wins when one price satisfies both levels", () => {
  // Inverted bracket: at 115 the price is both <= stop (120) and >= target
  // (110), so both conditions hold. The pessimistic branch must win so
  // simulated results never flatter the strategy.
  const degenerate = { side: "LONG" as const, stopLoss: 120, takeProfit: 110 };
  assert.deepEqual(exitFor(degenerate, 115), { price: 120, reason: "STOP_LOSS" });

  const degenerateShort = { side: "SHORT" as const, stopLoss: 110, takeProfit: 120 };
  assert.deepEqual(exitFor(degenerateShort, 115), { price: 110, reason: "STOP_LOSS" });
});

test("a trade with no protective levels never auto-exits", () => {
  const unprotected = { side: "LONG" as const, stopLoss: null, takeProfit: null };
  assert.equal(exitFor(unprotected, 1), null);
  assert.equal(exitFor(unprotected, 1_000_000), null);
});

test("only the level that exists is considered", () => {
  const stopOnly = { side: "LONG" as const, stopLoss: 95, takeProfit: null };
  assert.equal(exitFor(stopOnly, 500), null);
  assert.equal(exitFor(stopOnly, 95)?.reason, "STOP_LOSS");
});
