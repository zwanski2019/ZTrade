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
