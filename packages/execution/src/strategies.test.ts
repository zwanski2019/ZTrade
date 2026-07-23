import test from "node:test";
import assert from "node:assert/strict";
import type { EngineEvent, Intent, StrategyContext } from "@ztrade/core";
import { ReplayClock } from "@ztrade/core";
import { BreakoutStrategy, VwapReversionStrategy } from "./strategies.ts";

function ctx(): StrategyContext {
  let seq = 0;
  return {
    clock: new ReplayClock(),
    strategyId: "test",
    nextIntentSeq: () => seq++,
    positionOf: () => 0,
  };
}

function kline(symbol: string, close: number, volume = 10, ts = 1): EngineEvent {
  return {
    type: "kline",
    symbol,
    interval: "1",
    open: close,
    high: close,
    low: close,
    close,
    volume,
    closed: true,
    exchangeTs: ts,
    localRecvTs: ts,
    seq: ts,
  };
}

function sides(intents: Intent[]): string[] {
  return intents.map((i) => (i.kind === "order" ? i.intent.side : "cancel"));
}

// ---------------------------------------------------------------------------
// Breakout
// ---------------------------------------------------------------------------

test("breakout does nothing before its window is full", () => {
  const s = new BreakoutStrategy("BTCUSDT", 5, 0.01);
  const c = ctx();
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(s.onEvent(kline("BTCUSDT", 100 + i), c), []);
  }
});

test("breakout buys a new high and sells a new low", () => {
  const s = new BreakoutStrategy("BTCUSDT", 5, 0.01);
  const c = ctx();

  // Establish a flat range 100..104.
  for (const p of [100, 101, 100, 102, 101]) s.onEvent(kline("BTCUSDT", p), c);

  // A close above the prior 5-bar high (102) breaks out long.
  assert.deepEqual(sides(s.onEvent(kline("BTCUSDT", 110), c)), ["buy"]);

  // Feed more highs, then break below the low → flip short.
  for (const p of [111, 112, 113, 114]) s.onEvent(kline("BTCUSDT", p), c);
  assert.deepEqual(sides(s.onEvent(kline("BTCUSDT", 80), c)), ["sell"]);
});

test("breakout does not re-enter the same direction", () => {
  const s = new BreakoutStrategy("BTCUSDT", 3, 0.01);
  const c = ctx();
  for (const p of [100, 101, 102]) s.onEvent(kline("BTCUSDT", p), c);

  assert.deepEqual(sides(s.onEvent(kline("BTCUSDT", 110), c)), ["buy"]);
  // Another new high while already long: no second buy.
  assert.deepEqual(s.onEvent(kline("BTCUSDT", 120), c), []);
});

test("breakout ignores unclosed bars (no lookahead)", () => {
  const s = new BreakoutStrategy("BTCUSDT", 3, 0.01);
  const c = ctx();
  const base = kline("BTCUSDT", 999);
  // Narrow to the kline member before overriding `closed`, so the type stays a
  // kline rather than widening to the whole EngineEvent union.
  const unclosed: EngineEvent = base.type === "kline" ? { ...base, closed: false } : base;
  for (let i = 0; i < 10; i++) assert.deepEqual(s.onEvent(unclosed, c), []);
});

test("breakout is replay-deterministic after reset", () => {
  const prices = [100, 101, 99, 103, 98, 110, 111, 90, 112];
  const run = (): string[] => {
    const s = new BreakoutStrategy("BTCUSDT", 4, 0.01);
    const c = ctx();
    const out: string[] = [];
    for (const p of prices) out.push(...sides(s.onEvent(kline("BTCUSDT", p), c)));
    return out;
  };
  assert.deepEqual(run(), run());
});

// ---------------------------------------------------------------------------
// VWAP reversion
// ---------------------------------------------------------------------------

test("vwap reversion buys when price stretches below fair value", () => {
  const s = new VwapReversionStrategy("BTCUSDT", 5, 1.5, 0.01);
  const c = ctx();

  // Build a stable VWAP around 100.
  for (let i = 0; i < 5; i++) s.onEvent(kline("BTCUSDT", 100, 10), c);

  // A close well below vwap (~2%) should be faded upward.
  const intents = s.onEvent(kline("BTCUSDT", 97, 10), c);
  assert.deepEqual(sides(intents), ["buy"]);
});

test("vwap reversion sells when price stretches above fair value", () => {
  const s = new VwapReversionStrategy("BTCUSDT", 5, 1.5, 0.01);
  const c = ctx();
  for (let i = 0; i < 5; i++) s.onEvent(kline("BTCUSDT", 100, 10), c);

  assert.deepEqual(sides(s.onEvent(kline("BTCUSDT", 103, 10), c)), ["sell"]);
});

test("vwap reversion stays flat inside the band", () => {
  const s = new VwapReversionStrategy("BTCUSDT", 5, 1.5, 0.01);
  const c = ctx();
  for (let i = 0; i < 5; i++) s.onEvent(kline("BTCUSDT", 100, 10), c);
  // 0.5% deviation is inside the 1.5% band.
  assert.deepEqual(s.onEvent(kline("BTCUSDT", 100.5, 10), c), []);
});

test("vwap is volume-weighted, not a simple mean", () => {
  const s = new VwapReversionStrategy("BTCUSDT", 3, 1.0, 0.01);
  const c = ctx();
  // A huge-volume print at 90 drags vwap far below the low-volume prints at 100.
  // The window fills on the third bar, so the signal fires there: vwap ≈ 90.02,
  // and a close at 100 is ~11% ABOVE fair value → sell. A simple mean would put
  // fair value near 96.7 and produce no signal, which is the whole distinction.
  s.onEvent(kline("BTCUSDT", 100, 1), c);
  s.onEvent(kline("BTCUSDT", 90, 1000), c);
  assert.deepEqual(sides(s.onEvent(kline("BTCUSDT", 100, 1), c)), ["sell"]);
});

test("vwap reversion is replay-deterministic after reset", () => {
  const prices: Array<[number, number]> = [
    [100, 10], [101, 12], [99, 8], [97, 20], [103, 15], [100, 10], [96, 30],
  ];
  const run = (): string[] => {
    const s = new VwapReversionStrategy("BTCUSDT", 4, 1.5, 0.01);
    const c = ctx();
    const out: string[] = [];
    for (const [p, v] of prices) out.push(...sides(s.onEvent(kline("BTCUSDT", p, v), c)));
    return out;
  };
  assert.deepEqual(run(), run());
});

test("both strategies emit valid, well-formed intents", () => {
  for (const s of [new BreakoutStrategy("BTCUSDT", 3), new VwapReversionStrategy("BTCUSDT", 3, 1)]) {
    const c = ctx();
    const all: Intent[] = [];
    for (let i = 0; i < 20; i++) {
      const p = 100 + (i % 2 === 0 ? -5 : 5) * (i % 4);
      all.push(...s.onEvent(kline("BTCUSDT", p, 10 + i), c));
    }
    for (const intent of all) {
      assert.equal(intent.kind, "order");
      if (intent.kind === "order") {
        assert.ok(intent.intent.qty > 0);
        assert.ok(["buy", "sell"].includes(intent.intent.side));
        assert.equal(intent.intent.symbol, "BTCUSDT");
        assert.ok(intent.intent.rationale.length > 0);
      }
    }
  }
});
