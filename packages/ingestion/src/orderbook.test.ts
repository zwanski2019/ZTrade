import test from "node:test";
import assert from "node:assert/strict";
import { OrderBook, type BookUpdate } from "./orderbook.ts";

function snapshot(u: number): BookUpdate {
  return {
    type: "snapshot",
    u,
    seq: u,
    bids: [["100", "5"], ["99", "10"]],
    asks: [["101", "5"], ["102", "10"]],
    exchangeTs: 1_000,
  };
}

function delta(u: number, bids: BookUpdate["bids"] = [], asks: BookUpdate["asks"] = []): BookUpdate {
  return { type: "delta", u, seq: u, bids, asks, exchangeTs: 1_000 + u };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test("a new book is EMPTY and serves nothing", () => {
  const book = new OrderBook("BTCUSDT");
  assert.equal(book.status, "EMPTY");
  assert.equal(book.snapshot(), null);
});

test("a delta before any snapshot is refused", () => {
  const book = new OrderBook("BTCUSDT");
  const result = book.apply(delta(1, [["100", "1"]]));

  assert.equal(result.applied, false);
  assert.match(result.reason ?? "", /before snapshot/);
  assert.equal(book.snapshot(), null);
});

test("a snapshot makes the book healthy and sorted best-first", () => {
  const book = new OrderBook("BTCUSDT");
  book.apply(snapshot(10));

  const view = book.snapshot();
  assert.ok(view);
  assert.deepEqual(view!.bids.map((l) => l.price), [100, 99]);
  assert.deepEqual(view!.asks.map((l) => l.price), [101, 102]);
});

test("deltas update, add and remove levels", () => {
  const book = new OrderBook("BTCUSDT");
  book.apply(snapshot(10));

  // Resize 100, add 98, delete 99 (size 0 is a removal, not a zero level).
  book.apply(delta(11, [["100", "7"], ["98", "3"], ["99", "0"]]));

  const view = book.snapshot()!;
  assert.deepEqual(
    view.bids.map((l) => [l.price, l.size]),
    [[100, 7], [98, 3]],
  );
});

// ---------------------------------------------------------------------------
// Sequence integrity — the core of §4.1
// ---------------------------------------------------------------------------

test("contiguous deltas apply cleanly", () => {
  const book = new OrderBook("BTCUSDT");
  book.apply(snapshot(10));

  for (let u = 11; u <= 20; u++) {
    assert.equal(book.apply(delta(u, [["100", String(u)]])).applied, true);
  }
  assert.equal(book.status, "HEALTHY");
  assert.equal(book.updateId, 20);
});

test("ACCEPTANCE: a sequence gap makes the book stale and it serves NOTHING", () => {
  const book = new OrderBook("BTCUSDT");
  book.apply(snapshot(10));
  book.apply(delta(11, [["100", "6"]]));

  // u=13 arrives; u=12 was lost. Our book no longer matches the exchange.
  const result = book.apply(delta(13, [["100", "9"]]));

  assert.equal(result.applied, false);
  assert.deepEqual(result.gap, { expected: 12, received: 13 });
  assert.equal(book.status, "STALE");

  // The whole point: no price can be read from a book that might be wrong.
  assert.equal(book.snapshot(), null);
});

test("further deltas are refused while stale, rather than compounding the error", () => {
  const book = new OrderBook("BTCUSDT");
  book.apply(snapshot(10));
  book.apply(delta(13)); // gap → stale

  // Even a perfectly contiguous follow-up must not be applied: the base is wrong.
  const result = book.apply(delta(14, [["100", "1"]]));
  assert.equal(result.applied, false);
  assert.match(result.reason ?? "", /stale/i);
  assert.equal(book.snapshot(), null);
});

test("ACCEPTANCE: a fresh snapshot fully recovers a stale book", () => {
  const book = new OrderBook("BTCUSDT");
  book.apply(snapshot(10));
  book.apply(delta(13)); // gap
  assert.equal(book.status, "STALE");

  book.apply(snapshot(100));

  assert.equal(book.status, "HEALTHY");
  assert.equal(book.reason, null);
  assert.ok(book.snapshot(), "the book serves prices again");
  // State is rebuilt from the snapshot, not merged with the corrupt remains.
  assert.equal(book.snapshot()!.bids.length, 2);
});

test("a re-delivered update is ignored without declaring a gap", () => {
  const book = new OrderBook("BTCUSDT");
  book.apply(snapshot(10));
  book.apply(delta(11));

  const result = book.apply(delta(11));
  assert.equal(result.applied, false);
  assert.equal(result.gap, undefined, "a duplicate is not a gap");
  assert.equal(book.status, "HEALTHY", "and must not stale the book");
});

test("a crossed book is detected even when sequencing looks perfect", () => {
  const book = new OrderBook("BTCUSDT");
  book.apply(snapshot(10));

  // Sequence is contiguous, but the result is impossible: bid 105 >= ask 101.
  // Sequence continuity proves we missed nothing; this proves we applied it right.
  const result = book.apply(delta(11, [["105", "1"]]));

  assert.equal(result.applied, false);
  assert.equal(book.status, "STALE");
  assert.match(book.reason ?? "", /crossed/i);
  assert.equal(book.snapshot(), null);
});

test("invalidate() stales a live book, for use on disconnect", () => {
  const book = new OrderBook("BTCUSDT");
  book.apply(snapshot(10));
  book.invalidate("socket closed");

  assert.equal(book.status, "STALE");
  assert.equal(book.snapshot(), null);
});

test("invalidate() on an untouched book leaves it EMPTY", () => {
  const book = new OrderBook("BTCUSDT");
  book.invalidate("socket closed");
  assert.equal(book.status, "EMPTY");
});

test("malformed level values are skipped, not turned into NaN", () => {
  const book = new OrderBook("BTCUSDT");
  book.apply(snapshot(10));
  book.apply(delta(11, [["not-a-number", "5"], ["97", "oops"]]));

  const view = book.snapshot()!;
  for (const level of [...view.bids, ...view.asks]) {
    assert.ok(Number.isFinite(level.price), `NaN price leaked: ${level.price}`);
    assert.ok(Number.isFinite(level.size), `NaN size leaked: ${level.size}`);
  }
});

test("identical message sequences produce identical books (determinism)", () => {
  const build = (): OrderBook => {
    const book = new OrderBook("BTCUSDT");
    book.apply(snapshot(1));
    book.apply(delta(2, [["100", "3"], ["98", "1"]], [["101", "2"]]));
    book.apply(delta(3, [["99", "0"]], [["103", "4"]]));
    return book;
  };

  assert.deepEqual(build().snapshot(), build().snapshot());
});

test("stats track what happened, for the metrics surface", () => {
  const book = new OrderBook("BTCUSDT");
  book.apply(snapshot(10));
  book.apply(delta(11));
  book.apply(delta(99)); // gap

  assert.equal(book.stats.snapshots, 1);
  assert.equal(book.stats.deltas, 1);
  assert.equal(book.stats.gaps, 1);
});
