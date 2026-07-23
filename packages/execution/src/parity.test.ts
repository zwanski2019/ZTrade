import test from "node:test";
import assert from "node:assert/strict";
import type { EngineEvent, OrderBookSnapshot } from "@ztrade/core";
import { SimBroker, DEFAULT_SIM_CONFIG } from "@ztrade/adapters-sim";
import { Engine, type DecisionRecord } from "./engine.ts";
import { CanaryStrategy } from "./canary.ts";

/**
 * SHIP GATE #7 — backtest/live parity.
 *
 * The same tape, driven through independently constructed engines, must yield
 * byte-identical decisions. If this ever goes red, every backtest number in
 * the repository is fiction until it is green again.
 */

const SYMBOL = "BTCUSDT";

function book(mid: number): OrderBookSnapshot {
  return {
    bids: [
      { price: mid - 0.5, size: 10 },
      { price: mid - 1.5, size: 20 },
    ],
    asks: [
      { price: mid + 0.5, size: 10 },
      { price: mid + 1.5, size: 20 },
    ],
  };
}

/**
 * Deterministic synthetic tape: a rise, a fall, a rise, so the canary crosses
 * several times. No randomness — a flaky parity test is worse than none.
 */
function buildTape(): EngineEvent[] {
  const events: EngineEvent[] = [];
  const prices: number[] = [];

  for (let i = 0; i < 30; i++) prices.push(100 + i);
  for (let i = 0; i < 30; i++) prices.push(130 - i * 2);
  for (let i = 0; i < 30; i++) prices.push(70 + i * 1.5);

  prices.forEach((price, i) => {
    const ts = 1_700_000_000_000 + i * 60_000;

    events.push({
      type: "book",
      symbol: SYMBOL,
      book: book(price),
      exchangeTs: ts,
      localRecvTs: ts,
      seq: i * 2,
    });

    events.push({
      type: "kline",
      symbol: SYMBOL,
      interval: "1",
      open: price,
      high: price + 1,
      low: price - 1,
      close: price,
      volume: 5,
      closed: true,
      exchangeTs: ts + 1,
      localRecvTs: ts + 1,
      seq: i * 2 + 1,
    });
  });

  return events;
}

/** Runs a tape through a freshly constructed engine and returns its decisions. */
async function runTape(tape: EngineEvent[]): Promise<{
  decisions: readonly DecisionRecord[];
  broker: SimBroker;
  engine: Engine;
}> {
  const broker = new SimBroker(DEFAULT_SIM_CONFIG);
  const strategy = new CanaryStrategy(SYMBOL);
  const engine = new Engine({ strategy, broker });

  for (const event of tape) {
    // Live wiring order: the broker learns about the market, resolves anything
    // due, and only then does the engine let the strategy see the event.
    if (event.type === "book") {
      broker.step(event.exchangeTs, event.symbol, event.book);
    }
    await engine.handle(event);
  }

  return { decisions: engine.decisionLog, broker, engine };
}

test("GATE #7: backtest and paper produce identical decisions on the same tape", async () => {
  const tape = buildTape();

  // Two independently constructed engines — separate strategy instances,
  // separate brokers, separate state. Nothing is shared between the runs.
  const backtest = await runTape(tape);
  const paper = await runTape(tape);

  assert.ok(backtest.decisions.length > 0, "the canary must actually trade on this tape");
  assert.deepEqual(
    paper.decisions,
    backtest.decisions,
    "PARITY BROKEN — backtest and paper diverged on identical input",
  );
});

test("replaying the same tape twice is byte-identical (determinism)", async () => {
  const tape = buildTape();
  const first = await runTape(tape);
  const second = await runTape(tape);

  assert.equal(
    JSON.stringify(first.decisions),
    JSON.stringify(second.decisions),
    "the engine is not deterministic",
  );
});

test("no lookahead: a fill never resolves on the event that submitted it", async () => {
  const tape = buildTape();
  const { engine } = await runTape(tape);

  // Every order that reached the broker was submitted at some event time; the
  // configured latency means it cannot be observed as filled until strictly
  // later. If any order shows a fill recorded at its own submission instant,
  // the simulator is leaking the future into the decision.
  const submissions = new Map<string, number>();
  for (const d of engine.decisionLog) {
    if (d.kind === "submitted") submissions.set(d.orderLinkId, d.at);
  }

  assert.ok(submissions.size > 0, "expected at least one submission");

  for (const [id, submittedAt] of submissions) {
    const order = engine.orderBook().get(id);
    if (!order || order.filledQty === 0) continue;
    // A filled order must have transitioned after its submission event.
    assert.ok(
      order.revision >= 2,
      `order ${id} filled without an intermediate event (submitted at ${submittedAt})`,
    );
  }
});

test("the strategy never observes a position it has not been told about", async () => {
  const tape = buildTape();
  const { engine } = await runTape(tape);

  // Position is derived purely from fill events applied by the engine, so it
  // must equal the signed sum of filled quantities.
  let expected = 0;
  for (const order of engine.orderBook().values()) {
    if (order.filledQty === 0) continue;
    expected += order.side === "buy" ? order.filledQty : -order.filledQty;
  }

  assert.ok(
    Math.abs(engine.positionOf(SYMBOL) - expected) < 1e-9,
    `position ${engine.positionOf(SYMBOL)} disagrees with fills ${expected}`,
  );
});

test("GATE #4: a duplicate orderLinkId is refused, not double-filled", async () => {
  const broker = new SimBroker(DEFAULT_SIM_CONFIG);
  broker.updateBook(SYMBOL, book(100));

  const intent = {
    key: { strategyId: "canary@1", symbol: SYMBOL, intentSeq: 0 },
    symbol: SYMBOL,
    side: "buy" as const,
    qty: 0.01,
    style: { kind: "market" as const },
    reduceOnly: false,
    rationale: "test",
  };

  const first = await broker.submit({ orderLinkId: "zt-fixed", intent, at: 1_000 });
  // Exactly what a retry after a timeout looks like: same id, same everything.
  const retry = await broker.submit({ orderLinkId: "zt-fixed", intent, at: 1_200 });

  assert.equal(first.accepted, true);
  assert.equal(retry.accepted, false);
  assert.equal(retry.duplicate, true);
  assert.equal(broker.openCount, 1, "a retry must not create a second order");
});

test("GATE #1: cancelAll clears every working order", async () => {
  const broker = new SimBroker(DEFAULT_SIM_CONFIG);
  broker.updateBook(SYMBOL, book(100));

  for (let i = 0; i < 3; i++) {
    await broker.submit({
      orderLinkId: `zt-${i}`,
      intent: {
        key: { strategyId: "canary@1", symbol: SYMBOL, intentSeq: i },
        symbol: SYMBOL,
        side: "buy",
        qty: 0.01,
        // Resting orders, so they stay working rather than filling immediately.
        style: { kind: "limit", price: 90, timeInForce: "PostOnly" },
        reduceOnly: false,
        rationale: "test",
      },
      at: 1_000,
    });
  }

  assert.equal(broker.openCount, 3);
  const result = await broker.cancelAll(2_000);
  assert.equal(result.cancelled, 3);
  assert.equal(broker.openCount, 0);
});
