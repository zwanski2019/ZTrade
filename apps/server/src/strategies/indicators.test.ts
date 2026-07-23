import test from "node:test";
import assert from "node:assert/strict";
import { bollinger, crossedAbove, crossedBelow, ema, macd, rsi, sma } from "./indicators.ts";

test("sma averages over the window and aligns to the end", () => {
  const result = sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(result, [2, 3, 4]);
});

test("sma returns empty when there is not enough data", () => {
  assert.deepEqual(sma([1, 2], 5), []);
});

test("ema seeds from the SMA and converges toward recent values", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8];
  const result = ema(values, 3);

  // First value is the SMA of [1,2,3].
  assert.equal(result[0], 2);
  assert.equal(result.length, values.length - 3 + 1);
  // Rising series: the EMA must rise but lag the last close.
  assert.ok(result.at(-1)! > result[0]!);
  assert.ok(result.at(-1)! < 8);
});

test("rsi pins to 100 when every change is a gain", () => {
  const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(rising, 14).at(-1), 100);
});

test("rsi pins to 0 when every change is a loss", () => {
  const falling = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(rsi(falling, 14).at(-1), 0);
});

test("rsi stays within bounds on mixed data", () => {
  const mixed = [44, 44.3, 44.1, 44.8, 45.1, 45.4, 45.4, 45.3, 45.1, 45.8,
                 46.1, 45.9, 46.0, 45.6, 46.3, 46.5, 46.2, 46.8, 46.6, 47.1];
  for (const value of rsi(mixed, 14)) {
    assert.ok(value >= 0 && value <= 100, `RSI out of bounds: ${value}`);
  }
});

test("macd lines end on the same candle", () => {
  const values = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 6) * 10);
  const { macd: line, signal, histogram } = macd(values);

  assert.ok(line.length > 0);
  assert.equal(signal.length, histogram.length);
  // The histogram is macd - signal on the shared tail.
  const offset = line.length - signal.length;
  assert.ok(Math.abs(histogram.at(-1)! - (line.at(-1)! - signal.at(-1)!)) < 1e-9);
  assert.ok(offset >= 0);
});

test("crossedAbove detects only the bar where the cross happens", () => {
  assert.equal(crossedAbove([1, 3], [2, 2]), true);
  assert.equal(crossedAbove([3, 4], [2, 2]), false); // already above
  assert.equal(crossedAbove([3, 1], [2, 2]), false); // crossing down
});

test("crossedBelow mirrors crossedAbove", () => {
  assert.equal(crossedBelow([3, 1], [2, 2]), true);
  assert.equal(crossedBelow([1, 0], [2, 2]), false);
});

test("bollinger bands bracket the middle band", () => {
  const values = [10, 12, 11, 13, 12, 14, 13, 15, 14, 16,
                  15, 17, 16, 18, 17, 19, 18, 20, 19, 21, 20];
  const { upper, middle, lower } = bollinger(values, 20, 2);

  assert.equal(upper.length, middle.length);
  assert.ok(upper.at(-1)! > middle.at(-1)!);
  assert.ok(lower.at(-1)! < middle.at(-1)!);
});

// ---------------------------------------------------------------------------
// Volatility, trend strength and correlation
// ---------------------------------------------------------------------------

import { adx, atr, atrPercent, correlation, returns, trueRange } from "./indicators.ts";
import type { Bar } from "./indicators.ts";

const flat: Bar[] = Array.from({ length: 40 }, () => ({ high: 101, low: 99, close: 100 }));

test("true range accounts for gaps, not just the bar's own span", () => {
  const bars: Bar[] = [
    { high: 100, low: 98, close: 99 },
    // Gaps up: the bar spans 2 but the move from the prior close is 6.
    { high: 105, low: 103, close: 104 },
  ];
  assert.deepEqual(trueRange(bars), [6]);
});

test("ATR is positive and stable on constant-range bars", () => {
  const series = atr(flat, 14);
  assert.ok(series.length > 0);
  assert.equal(series.at(-1), 2);
});

test("atrPercent expresses ATR relative to price", () => {
  const series = atrPercent(flat, 14);
  // Range of 2 on a price of 100 is 2%.
  assert.ok(Math.abs(series.at(-1)! - 0.02) < 1e-9);
});

test("ATR returns empty rather than throwing on short input", () => {
  assert.deepEqual(atr([{ high: 1, low: 0, close: 0.5 }], 14), []);
  assert.deepEqual(trueRange([]), []);
});

test("ADX is high in a trend and low in a chop", () => {
  const trend: Bar[] = Array.from({ length: 120 }, (_, i) => ({
    high: 100 + i + 0.3,
    low: 100 + i - 0.3,
    close: 100 + i,
  }));
  const chop: Bar[] = Array.from({ length: 120 }, (_, i) => {
    const c = 100 + Math.sin(i / 2) * 0.5;
    return { high: c + 0.2, low: c - 0.2, close: c };
  });

  assert.ok(adx(trend).at(-1)! > 25, "trend should read as strong");
  assert.ok(adx(chop).at(-1)! < 20, "chop should read as weak");
});

test("ADX stays within 0..100", () => {
  for (const value of adx(flat.concat(flat))) {
    assert.ok(value >= 0 && value <= 100, `ADX out of range: ${value}`);
  }
});

test("returns converts prices to fractional changes", () => {
  assert.deepEqual(returns([100, 110, 99]), [0.1, -0.1]);
});

test("identical series correlate at +1 and inverted at -1", () => {
  const a = returns([100, 101, 103, 102, 105, 104]);
  const inverted = a.map((v) => -v);

  assert.ok(Math.abs(correlation(a, a) - 1) < 1e-9);
  assert.ok(Math.abs(correlation(a, inverted) + 1) < 1e-9);
});

test("correlation is bounded and symmetric", () => {
  const a = returns([100, 102, 101, 104, 103, 106]);
  const b = returns([50, 51, 50.4, 52, 51.6, 53]);

  const ab = correlation(a, b);
  assert.ok(ab >= -1 && ab <= 1);
  assert.ok(Math.abs(ab - correlation(b, a)) < 1e-12);
});

test("a flat series correlates with nothing rather than dividing by zero", () => {
  const moving = returns([100, 101, 102, 103]);
  const constant = returns([100, 100, 100, 100]);
  assert.equal(correlation(moving, constant), 0);
});

test("correlation needs at least two points", () => {
  assert.equal(correlation([0.1], [0.2]), 0);
  assert.equal(correlation([], []), 0);
});
