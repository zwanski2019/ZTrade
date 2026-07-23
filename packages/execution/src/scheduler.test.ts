import test from "node:test";
import assert from "node:assert/strict";
import type { OrderBookSnapshot, OrderIntent } from "@ztrade/core";
import { RateScheduler, DEFAULT_BUCKETS } from "./scheduler.ts";
import { checkSlippage, planIceberg, planRepeg, planTwap } from "./smartExec.ts";

// ---------------------------------------------------------------------------
// Rate scheduler
// ---------------------------------------------------------------------------

test("a fresh bucket allows a burst up to capacity, then refuses", () => {
  const s = new RateScheduler(0, { ...DEFAULT_BUCKETS, order: { refillPerSecond: 10, capacity: 3 } });

  for (let i = 0; i < 3; i++) assert.equal(s.take("order", 0), true, `burst ${i}`);
  assert.equal(s.take("order", 0), false, "capacity exhausted");
});

test("tokens refill over time at the configured rate", () => {
  const s = new RateScheduler(0, { ...DEFAULT_BUCKETS, order: { refillPerSecond: 10, capacity: 2 } });
  s.take("order", 0);
  s.take("order", 0);
  assert.equal(s.take("order", 0), false);

  // 10/sec → one token per 100ms.
  assert.equal(s.take("order", 100), true);
});

test("waitMs reports how long until a token is available", () => {
  const s = new RateScheduler(0, { ...DEFAULT_BUCKETS, order: { refillPerSecond: 10, capacity: 1 } });
  s.take("order", 0);
  assert.equal(s.waitMs("order", 0), 100);
  assert.equal(s.waitMs("order", 100), 0);
});

test("categories are metered independently", () => {
  // One global bucket would let a market-data burst starve order placement.
  const s = new RateScheduler(0, {
    ...DEFAULT_BUCKETS,
    order: { refillPerSecond: 1, capacity: 1 },
    market: { refillPerSecond: 1, capacity: 1 },
  });

  assert.equal(s.take("market", 0), true);
  assert.equal(s.take("market", 0), false);
  assert.equal(s.take("order", 0), true, "orders must not be starved by market data");
});

test("a rate-limit rejection triggers exponential back-off", () => {
  const s = new RateScheduler(0);

  assert.equal(s.observeRejection("order", 10006, 0), true);
  assert.equal(s.canSend("order", 0), false);
  // 500ms for the first hit.
  assert.equal(s.canSend("order", 600), true);

  s.observeRejection("order", 10006, 600);
  s.observeRejection("order", 10018, 700);
  // Escalating, not linear: retrying linearly into a limit turns a throttle
  // into a ban.
  assert.ok(s.waitMs("order", 700) >= 1_000, "back-off must escalate");
});

test("a non-rate-limit error code does not trigger back-off", () => {
  const s = new RateScheduler(0);
  assert.equal(s.observeRejection("order", 110001, 0), false);
  assert.equal(s.canSend("order", 0), true);
});

test("a success clears the escalating back-off", () => {
  const s = new RateScheduler(0);
  s.observeRejection("order", 10006, 0);
  s.observeRejection("order", 10006, 0);
  assert.equal(s.backoffLevel, 2);

  s.observeSuccess();
  assert.equal(s.backoffLevel, 0);
});

test("the venue's own header count is authoritative downward", () => {
  const s = new RateScheduler(0, { ...DEFAULT_BUCKETS, order: { refillPerSecond: 10, capacity: 20 } });
  assert.equal(s.availableTokens("order"), 20);

  // The venue counts requests we may not know about — SDK retries, another
  // process on the same key — so we only ever lower our estimate.
  s.observeHeaders("order", { "x-bapi-limit-status": "3" });
  assert.equal(s.availableTokens("order"), 3);

  s.observeHeaders("order", { "x-bapi-limit-status": "999" });
  assert.equal(s.availableTokens("order"), 3, "a header must never inflate our estimate");
});

test("a malformed header is ignored rather than zeroing the bucket", () => {
  const s = new RateScheduler(0);
  const before = s.availableTokens("order");
  s.observeHeaders("order", { "x-bapi-limit-status": "not-a-number" });
  assert.equal(s.availableTokens("order"), before);
});

// ---------------------------------------------------------------------------
// TWAP
// ---------------------------------------------------------------------------

const SYMBOL = "BTCUSDT";

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    key: { strategyId: "s@1", symbol: SYMBOL, intentSeq: 0 },
    symbol: SYMBOL,
    side: "buy",
    qty: 1,
    style: { kind: "market" },
    reduceOnly: false,
    rationale: "t",
    ...overrides,
  };
}

test("TWAP splits the parent evenly across the window", () => {
  const children = planTwap(
    intent({ qty: 1, style: { kind: "twap", windowMs: 60_000, slices: 4 } }),
    1_000,
    0.001,
  );

  assert.equal(children.length, 4);
  assert.deepEqual(children.map((c) => c.at), [1_000, 21_000, 41_000, 61_000]);
  const total = children.reduce((s, c) => s + c.qty, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `children must sum to the parent, got ${total}`);
});

test("TWAP gives the rounding remainder to the last slice", () => {
  // 1 / 3 does not divide evenly into 0.001 steps; the parent must still be
  // fully worked rather than quietly short.
  const children = planTwap(
    intent({ qty: 1, style: { kind: "twap", windowMs: 30_000, slices: 3 } }),
    0,
    0.001,
  );

  const total = children.reduce((s, c) => s + c.qty, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `expected 1, got ${total}`);
});

test("TWAP collapses to a single order when slices would be sub-minimum", () => {
  const children = planTwap(
    intent({ qty: 0.001, style: { kind: "twap", windowMs: 60_000, slices: 10 } }),
    0,
    0.001,
  );

  assert.equal(children.length, 1, "one order beats ten the venue will reject");
  assert.equal(children[0]!.qty, 0.001);
});

test("a single-slice TWAP fires immediately", () => {
  const children = planTwap(
    intent({ qty: 1, style: { kind: "twap", windowMs: 60_000, slices: 1 } }),
    5_000,
    0.001,
  );
  assert.equal(children.length, 1);
  assert.equal(children[0]!.at, 5_000);
});

// ---------------------------------------------------------------------------
// Iceberg
// ---------------------------------------------------------------------------

test("iceberg splits into display-sized clips", () => {
  const children = planIceberg(
    intent({ qty: 1, style: { kind: "iceberg", displayQty: 0.25 } }),
    0,
    60_000,
    0.001,
  );

  assert.equal(children.length, 4);
  for (const child of children) {
    assert.equal(child.qty, 0.25);
    assert.equal(child.postOnly, true);
    assert.equal(child.price, 60_000);
  }
});

test("iceberg handles a non-dividing remainder", () => {
  const children = planIceberg(
    intent({ qty: 1, style: { kind: "iceberg", displayQty: 0.3 } }),
    0,
    60_000,
    0.001,
  );

  const total = children.reduce((s, c) => s + c.qty, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.equal(children.at(-1)!.qty, 0.1, "the final clip carries the remainder");
});

test("iceberg collapses when the display size is not smaller than the parent", () => {
  const children = planIceberg(
    intent({ qty: 1, style: { kind: "iceberg", displayQty: 2 } }),
    0,
    60_000,
    0.001,
  );
  assert.equal(children.length, 1);
  assert.equal(children[0]!.qty, 1);
});

// ---------------------------------------------------------------------------
// Post-only re-peg
// ---------------------------------------------------------------------------

function book(bid: number, ask: number): OrderBookSnapshot {
  return { bids: [{ price: bid, size: 5 }], asks: [{ price: ask, size: 5 }] };
}

test("a resting order already at the touch does not re-peg", () => {
  // Moving would surrender queue position, which is the entire economic
  // advantage of resting in the first place.
  assert.equal(planRepeg("buy", 100, book(100, 101), 0, 5, 0.1), null);
});

test("a re-peg follows the market away from us", () => {
  // Best bid moved up to 101; our 100 is now behind the touch.
  assert.equal(planRepeg("buy", 100, book(101, 102), 0, 5, 0.1), 101);
});

test("a re-peg does NOT chase a market that moved in our favour", () => {
  // Best bid fell to 99; our resting 100 is better than the touch. Keep it.
  assert.equal(planRepeg("buy", 100, book(99, 100.5), 0, 5, 0.1), null);
});

test("re-pegging stops at the configured limit", () => {
  // An order that has chased a dozen times is one whose thesis has expired.
  assert.equal(planRepeg("buy", 100, book(105, 106), 5, 5, 0.1), null);
});

test("re-peg mirrors correctly for a sell", () => {
  assert.equal(planRepeg("sell", 101, book(99, 100), 0, 5, 0.1), 100);
  assert.equal(planRepeg("sell", 101, book(101, 102), 0, 5, 0.1), null);
});

// ---------------------------------------------------------------------------
// Slippage guard
// ---------------------------------------------------------------------------

const DEEP: OrderBookSnapshot = {
  bids: [{ price: 99, size: 1 }, { price: 98, size: 10 }],
  asks: [{ price: 101, size: 1 }, { price: 102, size: 10 }],
};

test("slippage is measured against a real sweep, not the mid", () => {
  // Buying 2 eats 101 then 102 → average 101.5, i.e. 150bps from a 100 mid.
  // Quoting the mid would wave this straight through.
  const verdict = checkSlippage(intent({ qty: 2 }), DEEP, 200);
  assert.equal(verdict.proceed, true);
  if (verdict.proceed) assert.equal(verdict.projectedBps, 150);
});

test("an order beyond the slippage limit is refused", () => {
  const verdict = checkSlippage(intent({ qty: 2 }), DEEP, 100);
  assert.equal(verdict.proceed, false);
});

test("a per-intent slippage limit overrides the default", () => {
  assert.equal(checkSlippage(intent({ qty: 2, maxSlippageBps: 10 }), DEEP, 10_000).proceed, false);
});

test("an order larger than the visible book is refused, not extrapolated", () => {
  // Assuming liquidity you cannot see is how you find out it is not there.
  const verdict = checkSlippage(intent({ qty: 999 }), DEEP, 10_000);
  assert.equal(verdict.proceed, false);
  if (!verdict.proceed) assert.match(verdict.reason, /depth/i);
});
