import test from "node:test";
import assert from "node:assert/strict";
import { BarAggregator, type Bar } from "./bars.ts";
import { LatencyTracker } from "./latency.ts";

const MINUTE = 60_000;
const T0 = 1_699_999_980_000; // verified: T0 % 60_000 === 0

function collector(): { bars: Bar[]; agg: BarAggregator } {
  const bars: Bar[] = [];
  const agg = new BarAggregator(MINUTE, "1", (bar) => bars.push(bar));
  return { bars, agg };
}

test("trades within one bucket build a single forming bar", () => {
  const { bars, agg } = collector();

  agg.onTrade("BTCUSDT", 100, 1, "buy", T0);
  agg.onTrade("BTCUSDT", 105, 2, "sell", T0 + 10_000);
  agg.onTrade("BTCUSDT", 95, 1, "buy", T0 + 20_000);

  assert.equal(bars.length, 0, "nothing closes until a later bucket starts");

  const pending = agg.pending("BTCUSDT")!;
  assert.equal(pending.open, 100);
  assert.equal(pending.high, 105);
  assert.equal(pending.low, 95);
  assert.equal(pending.close, 95);
  assert.equal(pending.volume, 4);
  assert.equal(pending.trades, 3);
  assert.equal(pending.buyVolume, 2, "taker buy volume tracked separately");
});

test("a trade in a later bucket closes the previous bar", () => {
  const { bars, agg } = collector();

  agg.onTrade("BTCUSDT", 100, 1, "buy", T0);
  agg.onTrade("BTCUSDT", 110, 1, "buy", T0 + MINUTE);

  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.closed, true);
  assert.equal(bars[0]!.openTime, T0);
  assert.equal(bars[0]!.close, 100);
  // The new bar has begun but is not closed — its close can still move.
  assert.equal(agg.pending("BTCUSDT")!.open, 110);
});

test("a bar is never emitted on its own last trade (no lookahead)", () => {
  // You cannot know a trade was the last of its bucket until the next bucket
  // starts, so closing early would be acting on information not yet available.
  const { bars, agg } = collector();
  for (let i = 0; i < 10; i++) agg.onTrade("BTCUSDT", 100 + i, 1, "buy", T0 + i * 1_000);
  assert.equal(bars.length, 0);
});

test("late trades for an already-closed bucket are dropped", () => {
  const { bars, agg } = collector();

  agg.onTrade("BTCUSDT", 100, 1, "buy", T0);
  agg.onTrade("BTCUSDT", 110, 1, "buy", T0 + MINUTE); // closes bucket 0
  agg.onTrade("BTCUSDT", 999, 5, "buy", T0 + 30_000); // belongs to bucket 0

  // Reopening a closed bar would mutate history a strategy already acted on.
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.close, 100, "the closed bar was not retroactively changed");
  assert.equal(agg.pending("BTCUSDT")!.close, 110);
});

test("closeExpired flushes buckets for an illiquid symbol", () => {
  const { bars, agg } = collector();
  agg.onTrade("BTCUSDT", 100, 1, "buy", T0);

  // No trades for several minutes; without this the bar stays open forever.
  agg.closeExpired(T0 + 3 * MINUTE);

  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.closed, true);
  assert.equal(agg.pending("BTCUSDT"), null);
});

test("closeExpired within the same bucket closes nothing", () => {
  const { bars, agg } = collector();
  agg.onTrade("BTCUSDT", 100, 1, "buy", T0);
  agg.closeExpired(T0 + 30_000);
  assert.equal(bars.length, 0);
});

test("symbols aggregate independently", () => {
  const { bars, agg } = collector();

  agg.onTrade("BTCUSDT", 100, 1, "buy", T0);
  agg.onTrade("ETHUSDT", 50, 2, "sell", T0);
  agg.onTrade("BTCUSDT", 101, 1, "buy", T0 + MINUTE);

  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.symbol, "BTCUSDT");
  assert.equal(agg.pending("ETHUSDT")!.open, 50);
});

test("bucket boundaries are half-open: [start, start+interval)", () => {
  const { agg } = collector();
  assert.equal(agg.bucketOf(T0), T0);
  assert.equal(agg.bucketOf(T0 + MINUTE - 1), T0);
  assert.equal(agg.bucketOf(T0 + MINUTE), T0 + MINUTE);
});

test("PROPERTY: the same trade sequence always produces the same bars", () => {
  // Bars must be identical in backtest and live, which requires the aggregator
  // itself to be a pure function of the trade stream.
  const run = (): Bar[] => {
    const { bars, agg } = collector();
    for (let i = 0; i < 200; i++) {
      agg.onTrade("BTCUSDT", 100 + (i % 17), 1 + (i % 3), i % 2 ? "buy" : "sell", T0 + i * 20_000);
    }
    agg.closeExpired(T0 + 500 * MINUTE);
    return bars;
  };

  assert.deepEqual(run(), run());
});

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

test("latency percentiles reflect the recorded distribution", () => {
  const tracker = new LatencyTracker(1000);
  for (let i = 1; i <= 100; i++) tracker.record(0, i);

  assert.equal(tracker.size, 100);
  assert.equal(tracker.p50, 50);
  assert.equal(tracker.p99, 99);
  assert.equal(tracker.max, 100);
});

test("clock skew is discarded rather than dragging the percentiles down", () => {
  const tracker = new LatencyTracker();
  tracker.record(1_000, 900); // "arrived before it was sent"
  assert.equal(tracker.size, 0);
});

test("the sample buffer is bounded, so a long-running process cannot leak", () => {
  const tracker = new LatencyTracker(64);
  for (let i = 0; i < 10_000; i++) tracker.record(0, i % 100);
  assert.equal(tracker.size, 64);
});

test("percentiles are null before any sample", () => {
  const tracker = new LatencyTracker();
  assert.equal(tracker.p50, null);
  assert.equal(tracker.p99, null);
  assert.equal(tracker.max, null);
});
