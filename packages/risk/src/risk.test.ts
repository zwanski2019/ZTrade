import test from "node:test";
import assert from "node:assert/strict";
import type { OrderIntent } from "@ztrade/core";
import { CircuitBreaker, blocksNewRisk, requiresFlatten } from "./breaker.ts";
import {
  correlationKey,
  correlatedNotional,
  DEFAULT_LIMITS,
  emptyPortfolio,
  RiskEngine,
  totalNotional,
  type PortfolioState,
  type RiskLimits,
} from "./engine.ts";

const SYMBOL = "BTCUSDT";

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    key: { strategyId: "s@1", symbol: SYMBOL, intentSeq: 0 },
    symbol: SYMBOL,
    side: "buy",
    qty: 0.01,
    style: { kind: "market" },
    reduceOnly: false,
    rationale: "test",
    ...overrides,
  };
}

function portfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return { ...emptyPortfolio(10_000), marks: new Map([[SYMBOL, 60_000]]), ...overrides };
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

test("the breaker escalates but never de-escalates on its own", () => {
  const breaker = new CircuitBreaker();

  assert.equal(breaker.escalate("DEGRADED", "drawdown", 1), true);
  assert.equal(breaker.state, "DEGRADED");

  // Flapping around a threshold would turn every boundary crossing into real
  // orders, so only an explicit reset returns to NORMAL.
  assert.equal(breaker.escalate("NORMAL", "recovered", 2), false);
  assert.equal(breaker.state, "DEGRADED");

  assert.equal(breaker.escalate("HALT", "daily loss", 3), true);
  assert.equal(breaker.escalate("DEGRADED", "less bad now", 4), false);
  assert.equal(breaker.state, "HALT");
});

test("an explicit reset is the only path back to NORMAL", () => {
  const breaker = new CircuitBreaker();
  breaker.escalate("HALT", "bad", 1);

  assert.equal(breaker.reset("operator cleared", 2), true);
  assert.equal(breaker.state, "NORMAL");
  assert.equal(breaker.reason, null);
});

test("every transition is recorded for the audit stream", () => {
  const seen: string[] = [];
  const breaker = new CircuitBreaker((t) => seen.push(`${t.from}->${t.to}`));

  breaker.escalate("DEGRADED", "a", 1);
  breaker.escalate("HALT", "b", 2);
  breaker.reset("c", 3);

  assert.deepEqual(seen, ["NORMAL->DEGRADED", "DEGRADED->HALT", "HALT->NORMAL"]);
  assert.equal(breaker.transitions().length, 3);
});

test("state semantics: DEGRADED blocks new risk, HALT also demands a flatten", () => {
  assert.equal(blocksNewRisk("NORMAL"), false);
  assert.equal(blocksNewRisk("DEGRADED"), true);
  assert.equal(blocksNewRisk("HALT"), true);

  assert.equal(requiresFlatten("DEGRADED"), false);
  assert.equal(requiresFlatten("HALT"), true);
});

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

test("a normal order passes", () => {
  const engine = new RiskEngine();
  const decision = engine.check(intent(), { portfolio: portfolio(), mark: 60_000, at: 0 });
  assert.equal(decision.allowed, true);
});

test("SANITY rejects non-finite or non-positive quantities", () => {
  const engine = new RiskEngine();
  for (const qty of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const d = engine.check(intent({ qty }), { portfolio: portfolio(), mark: 60_000, at: 0 });
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.check, "SANITY");
  }
});

test("SANITY rejects an unusable mark price", () => {
  const engine = new RiskEngine();
  const d = engine.check(intent(), { portfolio: portfolio(), mark: 0, at: 0 });
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.check, "SANITY");
});

test("POSITION_NOTIONAL caps a single symbol", () => {
  const engine = new RiskEngine({ ...DEFAULT_LIMITS, maxPositionNotional: 1_000 });
  // 0.02 * 60000 = 1200 > 1000
  const d = engine.check(intent({ qty: 0.02 }), { portfolio: portfolio(), mark: 60_000, at: 0 });
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.check, "POSITION_NOTIONAL");
});

test("POSITION_NOTIONAL counts the position already held", () => {
  const engine = new RiskEngine({ ...DEFAULT_LIMITS, maxPositionNotional: 1_000 });
  const p = portfolio({ positions: new Map([[SYMBOL, 0.015]]) }); // 900 already

  const d = engine.check(intent({ qty: 0.005 }), { portfolio: p, mark: 60_000, at: 0 });
  assert.equal(d.allowed, false, "900 + 300 exceeds the 1000 cap");
});

test("AGGREGATE_NOTIONAL caps total exposure across symbols", () => {
  const engine = new RiskEngine({
    ...DEFAULT_LIMITS,
    maxPositionNotional: 10_000,
    maxAggregateNotional: 2_000,
    maxLeverage: 100,
    maxCorrelatedNotional: 1e9,
  });

  const p = portfolio({
    positions: new Map([["ETHUSDT", 1]]),
    marks: new Map([[SYMBOL, 60_000], ["ETHUSDT", 1_800]]),
  });

  const d = engine.check(intent({ qty: 0.01 }), { portfolio: p, mark: 60_000, at: 0 });
  assert.equal(d.allowed, false, "1800 + 600 exceeds the 2000 aggregate cap");
  if (!d.allowed) assert.equal(d.check, "AGGREGATE_NOTIONAL");
});

test("LEVERAGE is enforced locally, not left to the venue", () => {
  const engine = new RiskEngine({
    ...DEFAULT_LIMITS,
    maxPositionNotional: 1e9,
    maxAggregateNotional: 1e9,
    maxCorrelatedNotional: 1e9,
    maxLeverage: 2,
  });

  // 0.1 BTC at 60k = 6000 notional on 1000 equity = 6x.
  const p = portfolio({ equity: 1_000 });
  const d = engine.check(intent({ qty: 0.1 }), { portfolio: p, mark: 60_000, at: 0 });

  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.check, "LEVERAGE");
});

test("PRICE_BAND rejects a fat-finger limit price", () => {
  const engine = new RiskEngine({ ...DEFAULT_LIMITS, maxPriceDeviationPct: 0.05 });

  const far = engine.check(
    intent({ style: { kind: "limit", price: 30_000, timeInForce: "GTC" } }),
    { portfolio: portfolio(), mark: 60_000, at: 0 },
  );
  assert.equal(far.allowed, false);
  if (!far.allowed) assert.equal(far.check, "PRICE_BAND");

  const near = engine.check(
    intent({ style: { kind: "limit", price: 59_000, timeInForce: "GTC" } }),
    { portfolio: portfolio(), mark: 60_000, at: 0 },
  );
  assert.equal(near.allowed, true);
});

test("ORDER_RATE stops a burst", () => {
  const engine = new RiskEngine({ ...DEFAULT_LIMITS, maxOrdersPerWindow: 3, rateWindowMs: 1_000 });
  const ctx = { portfolio: portfolio(), mark: 60_000, at: 0 };

  for (let i = 0; i < 3; i++) {
    assert.equal(engine.check(intent(), ctx).allowed, true, `order ${i} should pass`);
  }

  const blocked = engine.check(intent(), ctx);
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) assert.equal(blocked.check, "ORDER_RATE");
});

test("the rate window slides, so a paced strategy is never blocked", () => {
  const engine = new RiskEngine({ ...DEFAULT_LIMITS, maxOrdersPerWindow: 2, rateWindowMs: 1_000 });
  const p = portfolio();

  engine.check(intent(), { portfolio: p, mark: 60_000, at: 0 });
  engine.check(intent(), { portfolio: p, mark: 60_000, at: 100 });
  assert.equal(engine.check(intent(), { portfolio: p, mark: 60_000, at: 200 }).allowed, false);

  // Once the window has passed, the earlier orders no longer count.
  assert.equal(engine.check(intent(), { portfolio: p, mark: 60_000, at: 2_000 }).allowed, true);
});

test("rejected orders do not consume rate budget", () => {
  // Otherwise a strategy emitting garbage could lock itself out of trading.
  const engine = new RiskEngine({ ...DEFAULT_LIMITS, maxOrdersPerWindow: 2, rateWindowMs: 60_000 });
  const ctx = { portfolio: portfolio(), mark: 60_000, at: 0 };

  for (let i = 0; i < 10; i++) engine.check(intent({ qty: -1 }), ctx); // all SANITY rejects

  assert.equal(engine.check(intent(), ctx).allowed, true);
});

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

test("CORRELATION treats correlated positions as one exposure", () => {
  const engine = new RiskEngine({
    ...DEFAULT_LIMITS,
    maxPositionNotional: 1e9,
    maxAggregateNotional: 1e9,
    maxLeverage: 1e9,
    maxCorrelatedNotional: 2_000,
    correlationThreshold: 0.8,
  });

  // ETH held at 1800 notional, correlated 0.9 with BTC. A further 600 of BTC
  // takes the combined "one trade" to 2400, over the 2000 cap.
  const p = portfolio({
    positions: new Map([["ETHUSDT", 1]]),
    marks: new Map([[SYMBOL, 60_000], ["ETHUSDT", 1_800]]),
    correlations: new Map([[correlationKey(SYMBOL, "ETHUSDT"), 0.9]]),
  });

  const d = engine.check(intent({ qty: 0.01 }), { portfolio: p, mark: 60_000, at: 0 });
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.check, "CORRELATION");
});

test("an uncorrelated position does not consume the correlated budget", () => {
  const engine = new RiskEngine({
    ...DEFAULT_LIMITS,
    maxPositionNotional: 1e9,
    maxAggregateNotional: 1e9,
    maxLeverage: 1e9,
    maxCorrelatedNotional: 2_000,
  });

  const p = portfolio({
    positions: new Map([["ETHUSDT", 1]]),
    marks: new Map([[SYMBOL, 60_000], ["ETHUSDT", 1_800]]),
    correlations: new Map([[correlationKey(SYMBOL, "ETHUSDT"), 0.1]]),
  });

  assert.equal(
    engine.check(intent({ qty: 0.01 }), { portfolio: p, mark: 60_000, at: 0 }).allowed,
    true,
  );
});

test("a strong NEGATIVE correlation still counts as concentration", () => {
  // -0.9 held short is the same trade as +0.9 held long.
  const p = portfolio({
    positions: new Map([["ETHUSDT", -1]]),
    marks: new Map([[SYMBOL, 60_000], ["ETHUSDT", 1_800]]),
    correlations: new Map([[correlationKey(SYMBOL, "ETHUSDT"), -0.95]]),
  });

  assert.equal(correlatedNotional(p, SYMBOL, 0.8), 1_800);
});

// ---------------------------------------------------------------------------
// Portfolio-level breaker
// ---------------------------------------------------------------------------

test("a daily loss beyond the limit HALTs the account", () => {
  const engine = new RiskEngine({ ...DEFAULT_LIMITS, maxDailyLossPct: 0.05 });
  const p = portfolio({ dayStartEquity: 10_000, realisedPnlToday: -600 });

  assert.equal(engine.evaluatePortfolio(p, 0), "HALT");
  const d = engine.check(intent(), { portfolio: p, mark: 60_000, at: 0 });
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.check, "BREAKER");
});

test("a drawdown from the high-water mark HALTs the account", () => {
  const engine = new RiskEngine({ ...DEFAULT_LIMITS, maxDrawdownPct: 0.1 });
  // Equity has fallen 20% from its peak, even though today may look flat.
  const p = portfolio({ equity: 8_000, highWaterMark: 10_000, dayStartEquity: 8_000 });

  assert.equal(engine.evaluatePortfolio(p, 0), "HALT");
});

test("a profitable day never trips the loss breaker", () => {
  const engine = new RiskEngine();
  const p = portfolio({ dayStartEquity: 10_000, realisedPnlToday: 5_000, highWaterMark: 10_000, equity: 15_000 });
  assert.equal(engine.evaluatePortfolio(p, 0), "NORMAL");
});

test("reduce-only orders survive the breaker, so a position can still be closed", () => {
  // Blocking these would trap the operator in the position the breaker tripped over.
  const engine = new RiskEngine();
  engine.breaker.escalate("HALT", "test", 0);

  const p = portfolio();
  assert.equal(engine.check(intent(), { portfolio: p, mark: 60_000, at: 0 }).allowed, false);
  assert.equal(
    engine.check(intent({ reduceOnly: true }), { portfolio: p, mark: 60_000, at: 0 }).allowed,
    true,
  );
});

test("every decision is logged, so a veto is never silent", () => {
  const engine = new RiskEngine({ ...DEFAULT_LIMITS, maxPositionNotional: 1 });
  engine.check(intent(), { portfolio: portfolio(), mark: 60_000, at: 0 });

  assert.equal(engine.decisionLog.length, 1);
  assert.equal(engine.decisionLog[0]!.allowed, false);
});

// ---------------------------------------------------------------------------
// PROPERTY (§10): risk never lets exposure exceed the cap under fuzzed intents
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("PROPERTY: accepted intents can never breach the aggregate notional cap", () => {
  const limits: RiskLimits = {
    ...DEFAULT_LIMITS,
    maxPositionNotional: 5_000,
    maxAggregateNotional: 10_000,
    maxLeverage: 1e9,
    maxCorrelatedNotional: 1e9,
    maxOrdersPerWindow: 1e9,
  };
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  const marks = new Map([["BTCUSDT", 60_000], ["ETHUSDT", 1_800], ["SOLUSDT", 140]]);

  for (let seed = 0; seed < 300; seed++) {
    const rng = makeRng(seed + 1);
    const engine = new RiskEngine(limits);
    const p = portfolio({ positions: new Map(), marks, equity: 1e9, highWaterMark: 1e9, dayStartEquity: 1e9 });

    for (let step = 0; step < 40; step++) {
      const symbol = symbols[Math.floor(rng() * symbols.length)]!;
      const mark = marks.get(symbol)!;
      const qty = (rng() * 5_000) / mark;

      const decision = engine.check(
        intent({ symbol, qty, key: { strategyId: "s@1", symbol, intentSeq: step } }),
        { portfolio: p, mark, at: step * 10 },
      );

      // Simulate the fill of anything risk allowed.
      if (decision.allowed) {
        p.positions.set(symbol, (p.positions.get(symbol) ?? 0) + qty);
      }

      assert.ok(
        totalNotional(p) <= limits.maxAggregateNotional + 1e-6,
        `seed ${seed} step ${step}: aggregate ${totalNotional(p)} breached cap`,
      );
    }
  }
});

test("PROPERTY: no fuzzed intent is ever accepted while the breaker blocks new risk", () => {
  for (let seed = 0; seed < 200; seed++) {
    const rng = makeRng(seed + 1);
    const engine = new RiskEngine();
    engine.breaker.escalate(rng() > 0.5 ? "HALT" : "DEGRADED", "fuzz", 0);

    for (let step = 0; step < 20; step++) {
      const decision = engine.check(
        intent({ qty: rng() * 0.001, reduceOnly: false }),
        { portfolio: portfolio(), mark: 60_000, at: step },
      );
      assert.equal(decision.allowed, false, `seed ${seed}: new risk accepted while blocked`);
    }
  }
});
