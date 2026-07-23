import test from "node:test";
import assert from "node:assert/strict";
import type { MarketEvent } from "@ztrade/core";
import {
  Atr,
  Ema,
  RealisedVolatility,
  RingBuffer,
  RollingMean,
  RollingVariance,
} from "./incremental.ts";
import { FeatureStore } from "./store.ts";

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

test("the ring buffer evicts oldest-first and reports what it dropped", () => {
  const ring = new RingBuffer(3);
  assert.equal(ring.push(1), undefined);
  assert.equal(ring.push(2), undefined);
  assert.equal(ring.push(3), undefined);
  assert.equal(ring.push(4), 1, "the evicted value must be returned");
  assert.deepEqual(ring.toArray(), [2, 3, 4]);
  assert.equal(ring.last, 4);
  assert.equal(ring.at(0), 2, "index 0 is the oldest retained value");
});

test("the ring buffer refuses a non-positive capacity", () => {
  assert.throws(() => new RingBuffer(0));
});

// ---------------------------------------------------------------------------
// Incremental == batch. This is the property that matters.
// ---------------------------------------------------------------------------

function naiveMean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function naiveVariance(values: number[]): number {
  const m = naiveMean(values);
  return values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
}

/** Deterministic pseudo-random series, so a failure is reproducible. */
function series(n: number, seed = 1): number[] {
  let state = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    out.push(60_000 + (state / 0x1_0000_0000) * 2_000);
  }
  return out;
}

test("PROPERTY: RollingMean equals a full recompute of its window", () => {
  const period = 20;
  const data = series(300);
  const rolling = new RollingMean(period);

  data.forEach((value, i) => {
    rolling.update(value);
    if (i + 1 >= period) {
      const expected = naiveMean(data.slice(i + 1 - period, i + 1));
      assert.ok(
        Math.abs(rolling.value - expected) < 1e-9,
        `at ${i}: incremental ${rolling.value} vs batch ${expected}`,
      );
    }
  });
});

test("PROPERTY: RollingVariance (Welford) equals a full recompute", () => {
  // The naive sum-of-squares formulation loses catastrophic precision at these
  // magnitudes; Welford must not.
  const period = 30;
  const data = series(400, 7);
  const rolling = new RollingVariance(period);

  data.forEach((value, i) => {
    rolling.update(value);
    if (i + 1 >= period) {
      const expected = naiveVariance(data.slice(i + 1 - period, i + 1));
      const relative = Math.abs(rolling.variance - expected) / Math.max(expected, 1e-9);
      assert.ok(relative < 1e-6, `at ${i}: incremental ${rolling.variance} vs batch ${expected}`);
    }
  });
});

test("variance is zero for a constant series and never negative", () => {
  const rolling = new RollingVariance(10);
  for (let i = 0; i < 50; i++) rolling.update(100);
  assert.ok(rolling.variance >= 0);
  assert.ok(rolling.variance < 1e-9);
});

test("PROPERTY: incremental EMA equals the batch EMA with the same seeding", () => {
  const period = 12;
  const data = series(200, 3);

  const batch: number[] = [];
  const k = 2 / (period + 1);
  let prev = naiveMean(data.slice(0, period));
  batch.push(prev);
  for (let i = period; i < data.length; i++) {
    prev = data[i]! * k + prev * (1 - k);
    batch.push(prev);
  }

  const ema = new Ema(period);
  const incremental: number[] = [];
  for (const value of data) {
    const out = ema.update(value);
    if (out !== null) incremental.push(out);
  }

  assert.equal(incremental.length, batch.length);
  for (let i = 0; i < batch.length; i++) {
    assert.ok(Math.abs(incremental[i]! - batch[i]!) < 1e-9, `EMA diverged at ${i}`);
  }
});

test("EMA returns null until it has a full seeding window", () => {
  const ema = new Ema(5);
  for (let i = 0; i < 4; i++) assert.equal(ema.update(100), null);
  assert.notEqual(ema.update(100), null);
});

test("ATR accounts for gaps via the previous close", () => {
  const atr = new Atr(3);
  atr.update(100, 98, 99);
  atr.update(105, 103, 104); // gap up: TR is 105-99 = 6, not 105-103 = 2
  atr.update(106, 104, 105);

  assert.ok(atr.value !== null);
  // Mean of TR [2, 6, 2] = 3.33; a gap-blind implementation would give 2.
  assert.ok(atr.value! > 3, `ATR ${atr.value} ignored the gap`);
});

test("realised volatility is null until it has enough returns, then positive", () => {
  const vol = new RealisedVolatility(10, 525_600);
  assert.equal(vol.update(100), null);

  for (const price of series(60, 11)) vol.update(price);
  assert.ok(vol.value !== null && vol.value > 0);
});

test("non-positive prices cannot poison the volatility estimate", () => {
  const vol = new RealisedVolatility(5);
  for (const price of series(30, 5)) vol.update(price);
  const before = vol.value;

  vol.update(0);
  vol.update(-1);

  assert.equal(vol.value, before, "invalid prices must be ignored, not logged");
  assert.ok(vol.value === null || Number.isFinite(vol.value));
});

// ---------------------------------------------------------------------------
// Feature store — replay determinism
// ---------------------------------------------------------------------------

const SYMBOL = "BTCUSDT";

function tape(): MarketEvent[] {
  const events: MarketEvent[] = [];
  series(120, 42).forEach((price, i) => {
    const ts = 1_700_000_000_000 + i * 60_000;

    events.push({
      type: "book",
      symbol: SYMBOL,
      book: {
        bids: [{ price: price - 1, size: 3 }, { price: price - 2, size: 6 }],
        asks: [{ price: price + 1, size: 1 }, { price: price + 2, size: 4 }],
      },
      exchangeTs: ts,
      localRecvTs: ts,
      seq: i * 3,
    });

    events.push({
      type: "trade",
      symbol: SYMBOL,
      price,
      size: 0.5,
      side: i % 2 === 0 ? "buy" : "sell",
      exchangeTs: ts,
      localRecvTs: ts,
      seq: i * 3 + 1,
    });

    events.push({
      type: "kline",
      symbol: SYMBOL,
      interval: "1",
      open: price,
      high: price + 5,
      low: price - 5,
      close: price,
      volume: 10,
      closed: true,
      exchangeTs: ts,
      localRecvTs: ts,
      seq: i * 3 + 2,
    });
  });
  return events;
}

test("PROPERTY: replaying a tape twice yields identical features", () => {
  // The guarantee that makes backtest and live features identical.
  const run = (): unknown => {
    const store = new FeatureStore();
    for (const event of tape()) store.onEvent(event);
    return store.get(SYMBOL);
  };

  assert.deepEqual(run(), run());
});

test("the store derives book microstructure features", () => {
  const store = new FeatureStore();
  for (const event of tape()) store.onEvent(event);

  const f = store.get(SYMBOL)!;
  assert.ok(f.bestBid !== null && f.bestAsk !== null);
  assert.ok(f.bestBid! < f.bestAsk!);
  assert.ok(f.spreadBps !== null && f.spreadBps! > 0);
  assert.ok(f.imbalance !== null && Math.abs(f.imbalance!) <= 1);
  assert.equal(f.bookFresh, true);
});

test("microprice leans toward the thinner side", () => {
  const store = new FeatureStore();
  store.onEvent({
    type: "book",
    symbol: SYMBOL,
    // Heavy bid, thin ask: price is more likely to move up, so the microprice
    // should sit above the mid of 100.
    book: { bids: [{ price: 99, size: 100 }], asks: [{ price: 101, size: 1 }] },
    exchangeTs: 1,
    localRecvTs: 1,
    seq: 0,
  });

  const f = store.get(SYMBOL)!;
  assert.ok(f.microprice! > 100, `microprice ${f.microprice} did not lean to the thin side`);
});

test("an unconfirmed bar does not move bar-based features", () => {
  const store = new FeatureStore();
  const base = { symbol: SYMBOL, interval: "1", localRecvTs: 1, seq: 0, exchangeTs: 1 };

  for (let i = 0; i < 50; i++) {
    store.onEvent({
      ...base,
      type: "kline",
      open: 100, high: 101, low: 99, close: 100,
      volume: 1,
      closed: false, // still forming — the close can still move
    });
  }

  // Acting on an unconfirmed bar is a lookahead bug, so nothing may accumulate.
  assert.equal(store.get(SYMBOL)?.emaFast ?? null, null);
});

test("markBookStale blanks book features rather than leaving stale numbers", () => {
  const store = new FeatureStore();
  for (const event of tape()) store.onEvent(event);
  assert.ok(store.get(SYMBOL)!.mid !== null);

  store.markBookStale(SYMBOL);

  const f = store.get(SYMBOL)!;
  assert.equal(f.bookFresh, false);
  // Blanked, not merely flagged: a consumer that forgets to check the flag
  // must not be handed a spread from a book that stopped updating.
  assert.equal(f.mid, null);
  assert.equal(f.bestBid, null);
  assert.equal(f.spreadBps, null);
  assert.equal(f.imbalance, null);
});

test("flow imbalance reflects taker direction", () => {
  const store = new FeatureStore();
  for (let i = 0; i < 60; i++) {
    store.onEvent({
      type: "trade",
      symbol: SYMBOL,
      price: 100,
      size: 1,
      side: "buy",
      exchangeTs: i,
      localRecvTs: i,
      seq: i,
    });
  }

  assert.ok(store.get(SYMBOL)!.flowImbalance! > 0.9, "all-buy flow should approach +1");
});
