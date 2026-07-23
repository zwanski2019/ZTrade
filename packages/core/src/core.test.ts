import test from "node:test";
import assert from "node:assert/strict";
import { ManualClock, ReplayClock } from "./clock.ts";
import { correlationId, orderLinkId } from "./ids.ts";
import { InProcessBus, Subjects, subjectMatches } from "./bus.ts";
import {
  bookImbalance,
  exceedsLimitBps,
  slippageBps,
  sweepPrice,
  topOfBook,
  type OrderBookSnapshot,
} from "./events.ts";

// ---------------------------------------------------------------------------
// Clock — the determinism boundary
// ---------------------------------------------------------------------------

test("ReplayClock advances only forwards", () => {
  const clock = new ReplayClock(1_000);
  clock.advanceTo(2_000);
  assert.equal(clock.now(), 2_000);

  // An out-of-order event must not rewind time, or windowed features would
  // depend on arrival order rather than event order.
  clock.advanceTo(1_500);
  assert.equal(clock.now(), 2_000);
});

test("ManualClock steps exactly as told", () => {
  const clock = new ManualClock(100);
  clock.advance(50);
  assert.equal(clock.now(), 150);
  clock.set(10);
  assert.equal(clock.now(), 10);
});

// ---------------------------------------------------------------------------
// Order identity — ship gate #4
// ---------------------------------------------------------------------------

const KEY = { strategyId: "canary@1", symbol: "BTCUSDT", intentSeq: 7 };

test("GATE #4: orderLinkId is deterministic across calls and processes", () => {
  // A retry must produce the SAME id, or the venue treats it as a new order.
  assert.equal(orderLinkId(KEY), orderLinkId({ ...KEY }));
});

test("GATE #4: any component change yields a different id", () => {
  const baseline = orderLinkId(KEY);
  assert.notEqual(orderLinkId({ ...KEY, intentSeq: 8 }), baseline);
  assert.notEqual(orderLinkId({ ...KEY, symbol: "ETHUSDT" }), baseline);
  assert.notEqual(orderLinkId({ ...KEY, strategyId: "canary@2" }), baseline);
});

test("orderLinkId fits Bybit's 36-character limit and is prefixed", () => {
  const id = orderLinkId(KEY);
  assert.ok(id.length <= 36, `id too long: ${id.length}`);
  assert.ok(id.startsWith("zt-"), "our orders must be identifiable during reconciliation");
  assert.match(id, /^[A-Za-z0-9_-]+$/);
});

test("distinct sequences do not collide across a long run", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5_000; i++) seen.add(orderLinkId({ ...KEY, intentSeq: i }));
  assert.equal(seen.size, 5_000, "orderLinkId collision");
});

test("correlationId is human-readable for log tracing", () => {
  assert.equal(correlationId(KEY), "canary@1:BTCUSDT:7");
});

// ---------------------------------------------------------------------------
// Bus — NATS-shaped subject matching
// ---------------------------------------------------------------------------

test("subject wildcards behave like NATS", () => {
  assert.equal(subjectMatches("md.BTCUSDT.book", "md.BTCUSDT.book"), true);
  assert.equal(subjectMatches("md.*.book", "md.BTCUSDT.book"), true);
  assert.equal(subjectMatches("md.>", "md.BTCUSDT.book"), true);
  assert.equal(subjectMatches("md.*", "md.BTCUSDT.book"), false, "* is one token only");
  assert.equal(subjectMatches("acct.>", "md.BTCUSDT.book"), false);
  assert.equal(subjectMatches("md.BTCUSDT.book", "md.BTCUSDT"), false);
});

test("the bus delivers to matching subscribers in order", async () => {
  const bus = new InProcessBus();
  const received: string[] = [];

  bus.subscribe<string>("md.>", (m) => void received.push(`a:${m}`));
  bus.subscribe<string>("md.BTCUSDT.book", (m) => void received.push(`b:${m}`));
  bus.subscribe<string>("acct.>", (m) => void received.push(`c:${m}`));

  await bus.publish(Subjects.marketData("BTCUSDT", "book"), "x");
  assert.deepEqual(received, ["a:x", "b:x"]);
});

test("a throwing subscriber does not stop delivery to the others", async () => {
  const errors: string[] = [];
  const bus = new InProcessBus((err) => errors.push(err.message));
  const received: string[] = [];

  bus.subscribe("t.>", () => {
    throw new Error("handler exploded");
  });
  bus.subscribe("t.>", () => void received.push("survived"));

  await bus.publish("t.one", {});
  assert.deepEqual(received, ["survived"]);
  assert.deepEqual(errors, ["handler exploded"]);
});

test("unsubscribe stops delivery", async () => {
  const bus = new InProcessBus();
  const received: number[] = [];
  const sub = bus.subscribe<number>("x.>", (m) => void received.push(m));

  await bus.publish("x.a", 1);
  sub.unsubscribe();
  await bus.publish("x.a", 2);

  assert.deepEqual(received, [1]);
});

// ---------------------------------------------------------------------------
// Book maths — what a slippage guard actually compares against
// ---------------------------------------------------------------------------

const BOOK: OrderBookSnapshot = {
  bids: [
    { price: 99, size: 1 },
    { price: 98, size: 5 },
  ],
  asks: [
    { price: 101, size: 1 },
    { price: 102, size: 5 },
  ],
};

test("topOfBook reports the touch and the mid", () => {
  assert.deepEqual(topOfBook(BOOK), { bid: 99, ask: 101, mid: 100 });
});

test("an empty side yields nulls rather than NaN", () => {
  const empty = topOfBook({ bids: [], asks: [] });
  assert.deepEqual(empty, { bid: null, ask: null, mid: null });
});

test("sweeping more than the top level pays the worse price", () => {
  // 1 @ 101 then 1 @ 102 → average 101.5. Anyone quoting 101 for size 2 is
  // pricing liquidity that is not there.
  assert.equal(sweepPrice(BOOK, "buy", 1), 101);
  assert.equal(sweepPrice(BOOK, "buy", 2), 101.5);
});

test("sweeping past the visible book returns null rather than extrapolating", () => {
  assert.equal(sweepPrice(BOOK, "buy", 999), null);
  assert.equal(sweepPrice(BOOK, "buy", 0), null);
});

test("slippage is measured against the mid, both directions", () => {
  // Buying 1 at 101 against a mid of 100 is 100bps.
  assert.equal(slippageBps(BOOK, "buy", 1), 100);
  assert.equal(slippageBps(BOOK, "sell", 1), 100);
});

test("exceedsLimitBps tolerates float dust at the boundary", () => {
  // The exact bug that spuriously rejected an at-the-limit order.
  assert.equal(exceedsLimitBps(50, 50), false);
  assert.equal(exceedsLimitBps(50.000000000000014, 50), false);
  assert.equal(exceedsLimitBps(50.1, 50), true);
});

test("book imbalance is bounded and signed", () => {
  assert.equal(bookImbalance({ bids: [{ price: 1, size: 10 }], asks: [] }), 1);
  assert.equal(bookImbalance({ bids: [], asks: [{ price: 1, size: 10 }] }), -1);
  assert.equal(bookImbalance({ bids: [], asks: [] }), 0);
  assert.ok(Math.abs(bookImbalance(BOOK)) <= 1);
});
