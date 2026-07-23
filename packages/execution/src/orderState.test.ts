import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOrderEvent,
  canTransition,
  isLive,
  isTerminal,
  newOrder,
  remainingQty,
  TERMINAL_STATES,
  type OrderEvent,
  type OrderRecord,
  type OrderState,
} from "./orderState.ts";

const base = () => newOrder({ orderLinkId: "zt-1", symbol: "BTCUSDT", side: "buy", qty: 1 });

function apply(order: OrderRecord, ...events: OrderEvent[]): OrderRecord {
  let current = order;
  for (const event of events) {
    const result = applyOrderEvent(current, event);
    if (result.ok) current = result.order;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test("a normal order walks NEW → SUBMITTED → ACK → FILLED", () => {
  const filled = apply(
    base(),
    { type: "submit" },
    { type: "ack", exchangeOrderId: "x1" },
    { type: "fill", qty: 1, price: 100, fee: 0.05, isMaker: false },
  );

  assert.equal(filled.state, "FILLED");
  assert.equal(filled.filledQty, 1);
  assert.equal(filled.avgPrice, 100);
  assert.equal(filled.exchangeOrderId, "x1");
});

test("partial fills accumulate a size-weighted average price", () => {
  const partial = apply(
    base(),
    { type: "submit" },
    { type: "ack", exchangeOrderId: "x1" },
    { type: "fill", qty: 0.5, price: 100, fee: 0.02, isMaker: true },
  );
  assert.equal(partial.state, "PARTIAL");
  assert.equal(partial.avgPrice, 100);

  const done = apply(partial, { type: "fill", qty: 0.5, price: 200, fee: 0.02, isMaker: true });
  assert.equal(done.state, "FILLED");
  // (100*0.5 + 200*0.5) / 1
  assert.equal(done.avgPrice, 150);
  assert.ok(Math.abs(done.feesPaid - 0.04) < 1e-12);
});

test("an execution event may legitimately beat the ack", () => {
  // Under load the fill can arrive first. Dropping it would lose a real fill.
  const filled = apply(base(), { type: "submit" }, {
    type: "fill",
    qty: 1,
    price: 100,
    fee: 0,
    isMaker: false,
  });
  assert.equal(filled.state, "FILLED");
});

test("an ack arriving after a partial fill does not walk the state backwards", () => {
  const partial = apply(
    base(),
    { type: "submit" },
    { type: "fill", qty: 0.5, price: 100, fee: 0, isMaker: false },
    { type: "ack", exchangeOrderId: "late" },
  );
  assert.equal(partial.state, "PARTIAL");
  assert.equal(partial.exchangeOrderId, "late");
});

test("a partially filled order can still be cancelled", () => {
  const cancelled = apply(
    base(),
    { type: "submit" },
    { type: "ack", exchangeOrderId: "x" },
    { type: "fill", qty: 0.3, price: 100, fee: 0, isMaker: false },
    { type: "cancel" },
  );
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(cancelled.filledQty, 0.3, "the filled portion stays filled");
  assert.ok(Math.abs(remainingQty(cancelled) - 0.7) < 1e-12);
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

test("an overfill is refused rather than silently accepted", () => {
  // Accepting it would corrupt position accounting and every risk check
  // downstream, which is far worse than a loud error.
  const acked = apply(base(), { type: "submit" }, { type: "ack", exchangeOrderId: "x" });
  const result = applyOrderEvent(acked, { type: "fill", qty: 2, price: 100, fee: 0, isMaker: false });

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /Overfill/);
});

test("a non-positive fill quantity is refused", () => {
  const acked = apply(base(), { type: "submit" }, { type: "ack", exchangeOrderId: "x" });
  for (const qty of [0, -1]) {
    const result = applyOrderEvent(acked, { type: "fill", qty, price: 100, fee: 0, isMaker: false });
    assert.equal(result.ok, false);
  }
});

test("terminal orders are immutable, and late duplicates are a quiet no-op", () => {
  const filled = apply(
    base(),
    { type: "submit" },
    { type: "fill", qty: 1, price: 100, fee: 0, isMaker: false },
  );

  // A REST poll racing the WS routinely re-delivers a terminal state. This is
  // normal operation, not an error, so it must not raise an alert.
  const late = applyOrderEvent(filled, { type: "cancel" });
  assert.equal(late.ok, true);
  if (late.ok) {
    assert.equal(late.transitioned, false);
    assert.equal(late.order.state, "FILLED");
  }

  // A FILL after terminal is different: it means our view is wrong.
  const badFill = applyOrderEvent(filled, { type: "fill", qty: 1, price: 100, fee: 0, isMaker: false });
  assert.equal(badFill.ok, false);
});

test("applying an event never mutates the input record", () => {
  const order = base();
  const snapshot = JSON.stringify(order);
  applyOrderEvent(order, { type: "submit" });
  assert.equal(JSON.stringify(order), snapshot);
});

// ---------------------------------------------------------------------------
// Property tests (§10): the machine must never reach an illegal state
// ---------------------------------------------------------------------------

const ALL_EVENTS: OrderEvent[] = [
  { type: "submit" },
  { type: "ack", exchangeOrderId: "x" },
  { type: "fill", qty: 0.25, price: 100, fee: 0.01, isMaker: false },
  { type: "cancel" },
  { type: "reject", reason: "fuzz" },
  { type: "expire" },
];

/** Deterministic PRNG so a failure is reproducible. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("PROPERTY: no fuzzed event sequence produces an illegal state or transition", () => {
  const legalStates = new Set<OrderState>([
    "NEW", "SUBMITTED", "ACK", "PARTIAL", "FILLED", "CANCELLED", "REJECTED", "EXPIRED",
  ]);

  for (let seed = 0; seed < 400; seed++) {
    const rng = makeRng(seed + 1);
    let order = base();

    for (let step = 0; step < 20; step++) {
      const event = ALL_EVENTS[Math.floor(rng() * ALL_EVENTS.length)]!;
      const before = order.state;
      const result = applyOrderEvent(order, event);

      if (!result.ok) continue; // Rejections are fine; they leave state intact.

      const after = result.order.state;
      assert.ok(legalStates.has(after), `seed ${seed}: reached unknown state ${after}`);

      if (after !== before) {
        assert.ok(
          canTransition(before, after),
          `seed ${seed}: illegal transition ${before} → ${after}`,
        );
      }
      order = result.order;
    }
  }
});

test("PROPERTY: filled quantity never exceeds the order quantity", () => {
  for (let seed = 0; seed < 400; seed++) {
    const rng = makeRng(seed + 1);
    let order = base();

    for (let step = 0; step < 25; step++) {
      const event = ALL_EVENTS[Math.floor(rng() * ALL_EVENTS.length)]!;
      const result = applyOrderEvent(order, event);
      if (result.ok) order = result.order;

      assert.ok(
        order.filledQty <= order.qty + 1e-9,
        `seed ${seed}: filled ${order.filledQty} exceeds qty ${order.qty}`,
      );
      assert.ok(remainingQty(order) >= 0, `seed ${seed}: negative remaining quantity`);
    }
  }
});

test("PROPERTY: a terminal state is absorbing", () => {
  for (let seed = 0; seed < 200; seed++) {
    const rng = makeRng(seed + 1);
    let order = base();
    let terminalState: OrderState | null = null;

    for (let step = 0; step < 25; step++) {
      const event = ALL_EVENTS[Math.floor(rng() * ALL_EVENTS.length)]!;
      const result = applyOrderEvent(order, event);
      if (result.ok) order = result.order;

      if (terminalState !== null) {
        assert.equal(order.state, terminalState, `seed ${seed}: escaped terminal state`);
      } else if (isTerminal(order.state)) {
        terminalState = order.state;
      }
    }
  }
});

test("isLive is exactly the complement of isTerminal", () => {
  for (const state of ["NEW", "SUBMITTED", "ACK", "PARTIAL", "FILLED", "CANCELLED", "REJECTED", "EXPIRED"] as OrderState[]) {
    const order = { ...base(), state };
    assert.equal(isLive(order), !TERMINAL_STATES.has(state));
  }
});
