import test from "node:test";
import assert from "node:assert/strict";
import type { MarketEvent } from "@ztrade/core";
import { BybitIngestion, type SocketLike } from "./bybitWs.ts";

/**
 * §4.1 ACCEPTANCE TEST
 *
 *   "kill the WS mid-session; book rebuilds cleanly with zero stale-price
 *    orders emitted during the gap."
 *
 * The transport is a mock so the failure paths — disconnect, gap, recovery —
 * can be driven exactly. Those paths only run when something is already going
 * wrong, which is precisely when they must be known-good.
 */
class MockSocket implements SocketLike {
  sent: string[] = [];
  private openHandler: (() => void) | null = null;
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeHandler?.();
  }
  onOpen(h: () => void): void {
    this.openHandler = h;
  }
  onMessage(h: (data: string) => void): void {
    this.messageHandler = h;
  }
  onClose(h: () => void): void {
    this.closeHandler = h;
  }
  onError(h: (err: Error) => void): void {
    this.errorHandler = h;
  }

  // --- test drivers ---
  open(): void {
    this.openHandler?.();
  }
  deliver(payload: unknown): void {
    this.messageHandler?.(JSON.stringify(payload));
  }
  deliverRaw(raw: string): void {
    this.messageHandler?.(raw);
  }
  kill(): void {
    this.closeHandler?.();
  }
  fail(message: string): void {
    this.errorHandler?.(new Error(message));
  }

  /** Topics this socket was asked to subscribe to. */
  subscriptions(): string[] {
    return this.sent
      .map((s) => JSON.parse(s) as { op?: string; args?: string[] })
      .filter((m) => m.op === "subscribe")
      .flatMap((m) => m.args ?? []);
  }
  unsubscriptions(): string[] {
    return this.sent
      .map((s) => JSON.parse(s) as { op?: string; args?: string[] })
      .filter((m) => m.op === "unsubscribe")
      .flatMap((m) => m.args ?? []);
  }
}

const SYMBOL = "BTCUSDT";

function bookMessage(type: "snapshot" | "delta", u: number, bid: string, ask: string) {
  return {
    topic: `orderbook.50.${SYMBOL}`,
    type,
    ts: 1_700_000_000_000 + u,
    data: { s: SYMBOL, b: [[bid, "5"]], a: [[ask, "5"]], u, seq: u },
  };
}

interface Harness {
  ingestion: BybitIngestion;
  sockets: MockSocket[];
  events: MarketEvent[];
  latest(): MockSocket;
}

function harness(): Harness {
  const sockets: MockSocket[] = [];
  const events: MarketEvent[] = [];

  const ingestion = new BybitIngestion({
    url: "wss://test",
    symbols: [SYMBOL],
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    onEvent: (event) => events.push(event),
    now: () => 1_700_000_000_500,
    reconnectDelayMs: 1,
  });

  ingestion.start();
  return { ingestion, sockets, events, latest: () => sockets.at(-1)! };
}

function bookEvents(events: MarketEvent[]): Array<Extract<MarketEvent, { type: "book" }>> {
  return events.filter((e): e is Extract<MarketEvent, { type: "book" }> => e.type === "book");
}

// ---------------------------------------------------------------------------

test("subscribes to book, trade and ticker topics on connect", () => {
  const h = harness();
  h.latest().open();

  const topics = h.latest().subscriptions();
  assert.ok(topics.includes(`orderbook.50.${SYMBOL}`));
  assert.ok(topics.includes(`publicTrade.${SYMBOL}`));
  assert.ok(topics.includes(`tickers.${SYMBOL}`));
});

test("emits a book event only after a snapshot", () => {
  const h = harness();
  h.latest().open();

  h.latest().deliver(bookMessage("delta", 5, "100", "101"));
  assert.equal(bookEvents(h.events).length, 0, "a delta alone must not produce prices");

  h.latest().deliver(bookMessage("snapshot", 10, "100", "101"));
  assert.equal(bookEvents(h.events).length, 1);
});

test("ACCEPTANCE: a mid-session gap emits nothing and triggers a rebuild", () => {
  const h = harness();
  h.latest().open();

  h.latest().deliver(bookMessage("snapshot", 10, "100", "101"));
  h.latest().deliver(bookMessage("delta", 11, "100.5", "101.5"));
  const beforeGap = bookEvents(h.events).length;
  assert.equal(beforeGap, 2);

  // u=12 is lost. Everything after this must be silent until a fresh snapshot.
  h.latest().deliver(bookMessage("delta", 13, "200", "201"));
  h.latest().deliver(bookMessage("delta", 14, "300", "301"));
  h.latest().deliver(bookMessage("delta", 15, "400", "401"));

  assert.equal(
    bookEvents(h.events).length,
    beforeGap,
    "ZERO book events may be emitted while the book is stale",
  );
  assert.equal(h.ingestion.book(SYMBOL)!.status, "STALE");

  // And it must have asked for a fresh snapshot.
  assert.ok(
    h.latest().unsubscriptions().includes(`orderbook.50.${SYMBOL}`),
    "a gap must trigger unsubscribe/resubscribe",
  );

  // The rebuild.
  h.latest().deliver(bookMessage("snapshot", 500, "150", "151"));

  assert.equal(h.ingestion.book(SYMBOL)!.status, "HEALTHY");
  const after = bookEvents(h.events);
  assert.equal(after.length, beforeGap + 1);

  // The recovered book carries the NEW prices, with none of the discarded ones.
  assert.equal(after.at(-1)!.book.bids[0]!.price, 150);
  const leaked = after.some((e) => e.book.bids[0]!.price >= 200);
  assert.equal(leaked, false, "a price from the gap window leaked into an event");
});

test("ACCEPTANCE: killing the socket invalidates the book before reconnect", () => {
  const h = harness();
  h.latest().open();
  h.latest().deliver(bookMessage("snapshot", 10, "100", "101"));
  assert.equal(h.ingestion.book(SYMBOL)!.isHealthy, true);

  h.latest().kill();

  // Updates that happened while we were disconnected are simply gone, so the
  // book cannot be trusted the instant the stream breaks.
  assert.equal(h.ingestion.book(SYMBOL)!.status, "STALE");
  assert.equal(h.ingestion.book(SYMBOL)!.snapshot(), null);

  const before = bookEvents(h.events).length;
  h.latest().deliver(bookMessage("delta", 11, "999", "1000"));
  assert.equal(bookEvents(h.events).length, before, "nothing may be emitted while down");
});

test("reconnect resubscribes and the book recovers from a fresh snapshot", async () => {
  const h = harness();
  h.latest().open();
  h.latest().deliver(bookMessage("snapshot", 10, "100", "101"));
  h.latest().kill();

  await new Promise((r) => setTimeout(r, 20));

  assert.equal(h.sockets.length, 2, "a new socket must be created");
  h.latest().open();
  assert.ok(h.latest().subscriptions().includes(`orderbook.50.${SYMBOL}`));

  h.latest().deliver(bookMessage("snapshot", 900, "105", "106"));
  assert.equal(h.ingestion.book(SYMBOL)!.isHealthy, true);
  assert.equal(bookEvents(h.events).at(-1)!.book.bids[0]!.price, 105);
});

// ---------------------------------------------------------------------------
// Fail-closed validation (§3)
// ---------------------------------------------------------------------------

test("malformed payloads are counted and dropped, never coerced", () => {
  const h = harness();
  h.latest().open();

  h.latest().deliverRaw("{not json");
  h.latest().deliver({ topic: `orderbook.50.${SYMBOL}`, type: "snapshot", ts: 1, data: { s: SYMBOL } });
  h.latest().deliver({ topic: `publicTrade.${SYMBOL}`, ts: 1, data: [{ T: 1, s: SYMBOL }] });

  assert.equal(bookEvents(h.events).length, 0);
  assert.ok(h.ingestion.snapshot().invalid >= 2, "invalid payloads must be counted");
});

test("control frames are ignored without being counted as invalid", () => {
  const h = harness();
  h.latest().open();

  h.latest().deliver({ op: "subscribe", success: true, conn_id: "abc" });
  h.latest().deliver({ op: "pong" });

  assert.equal(h.ingestion.snapshot().invalid, 0);
});

test("string-encoded numerics are normalised to real numbers", () => {
  const h = harness();
  h.latest().open();

  h.latest().deliver({
    topic: `publicTrade.${SYMBOL}`,
    ts: 1_700_000_000_000,
    data: [{ T: 1_700_000_000_000, s: SYMBOL, S: "Buy", v: "0.5", p: "64000.5" }],
  });

  const trade = h.events.find((e) => e.type === "trade");
  assert.ok(trade && trade.type === "trade");
  assert.equal(typeof trade.price, "number");
  assert.equal(trade.price, 64000.5);
  assert.equal(trade.size, 0.5);
  assert.equal(trade.side, "buy", "Bybit's S is the taker side");
});

test("latency is measured from the exchange/local timestamp pair", () => {
  const h = harness();
  h.latest().open();
  h.latest().deliver(bookMessage("snapshot", 10, "100", "101"));

  const stats = h.ingestion.snapshot().latency;
  assert.ok(stats.count > 0);
  assert.ok(stats.p50 !== null && stats.p50 >= 0);
});

test("every emitted event carries both timestamps", () => {
  const h = harness();
  h.latest().open();
  h.latest().deliver(bookMessage("snapshot", 10, "100", "101"));

  for (const event of h.events) {
    assert.ok(Number.isFinite(event.exchangeTs));
    assert.ok(Number.isFinite(event.localRecvTs));
    assert.ok(Number.isFinite(event.seq));
  }
});
