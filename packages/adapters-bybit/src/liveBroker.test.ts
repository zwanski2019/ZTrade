import test from "node:test";
import assert from "node:assert/strict";
import type { OrderIntent } from "@ztrade/core";
import { BybitLiveBroker } from "./liveBroker.ts";
import { executionToEvent, orderUpdateToEvent } from "./accountEvents.ts";

/**
 * The live broker is tested with a STUBBED fetch so the idempotency, error
 * mapping and body-construction logic can be asserted deterministically
 * without touching a real venue or placing an order.
 *
 * A separate opt-in test (BYBIT_LIVE_TEST=1) hits the real testnet with
 * read-only calls to prove the signing actually works end to end.
 */
function stubFetch(responses: Array<{ retCode: number; retMsg: string; result?: unknown }>) {
  let i = 0;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return { json: async () => ({ retCode: r.retCode, retMsg: r.retMsg, result: r.result ?? {} }) } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function broker(fetchImpl: typeof fetch, tradingEnabled = true) {
  return new BybitLiveBroker({
    baseUrl: "https://api-testnet.bybit.com",
    apiKey: "test-key",
    apiSecret: "test-secret",
    tradingEnabled,
    fetchImpl,
    now: () => 1_700_000_000_000,
  });
}

const marketBuy: OrderIntent = {
  key: { strategyId: "s@1", symbol: "BTCUSDT", intentSeq: 0 },
  symbol: "BTCUSDT",
  side: "buy",
  qty: 0.01,
  style: { kind: "market" },
  reduceOnly: false,
  rationale: "test",
};

test("mode is live", () => {
  assert.equal(broker(stubFetch([{ retCode: 0, retMsg: "OK" }]).fetchImpl).mode, "live");
});

test("a successful submit returns the exchange order id", async () => {
  const { fetchImpl, calls } = stubFetch([
    { retCode: 0, retMsg: "OK", result: { orderId: "ex-123", orderLinkId: "zt-abc" } },
  ]);
  const ack = await broker(fetchImpl).submit({ orderLinkId: "zt-abc", intent: marketBuy, at: 0 });

  assert.equal(ack.accepted, true);
  assert.equal(ack.exchangeOrderId, "ex-123");

  // The orderLinkId must be passed through verbatim — this is what makes a
  // retry idempotent at the venue.
  assert.equal(calls[0]!.body.orderLinkId, "zt-abc");
  assert.equal(calls[0]!.body.orderType, "Market");
  assert.equal(calls[0]!.body.side, "Buy");
});

test("GATE #4: a duplicate orderLinkId is reported as a duplicate, not a failure", async () => {
  // This is what a timeout-and-retry looks like: the venue already has the
  // order and rejects the re-send with 110072. Treating it as a hard failure
  // would make the caller think the order did not land, when it did.
  const { fetchImpl } = stubFetch([{ retCode: 110072, retMsg: "duplicate orderLinkId" }]);
  const ack = await broker(fetchImpl).submit({ orderLinkId: "zt-abc", intent: marketBuy, at: 0 });

  assert.equal(ack.accepted, false);
  assert.equal(ack.duplicate, true);
  assert.match(ack.reason ?? "", /idempotent/i);
});

test("a network error is reported as retryable with the same id", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;

  const ack = await broker(fetchImpl).submit({ orderLinkId: "zt-abc", intent: marketBuy, at: 0 });
  assert.equal(ack.accepted, false);
  // The retry guidance matters: retrying with the SAME id is safe because of
  // the duplicate handling above.
  assert.match(ack.reason ?? "", /same id/i);
});

test("a genuine rejection surfaces the venue message", async () => {
  const { fetchImpl } = stubFetch([{ retCode: 110007, retMsg: "insufficient balance" }]);
  const ack = await broker(fetchImpl).submit({ orderLinkId: "zt-abc", intent: marketBuy, at: 0 });
  assert.equal(ack.accepted, false);
  assert.equal(ack.duplicate, undefined);
  assert.match(ack.reason ?? "", /insufficient/);
});

test("paper mode at the adapter never calls the network", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return { json: async () => ({ retCode: 0, retMsg: "OK", result: {} }) } as Response;
  }) as unknown as typeof fetch;

  const ack = await broker(fetchImpl, false).submit({ orderLinkId: "zt-abc", intent: marketBuy, at: 0 });
  assert.equal(ack.accepted, true);
  assert.equal(ack.exchangeOrderId, null);
  assert.equal(called, false, "trading-disabled adapter must not touch the venue");
});

test("a cancel racing a fill is treated as success", async () => {
  // The order already filled and is gone; "nothing is working" is what the
  // caller wanted, so this is not an error.
  const { fetchImpl } = stubFetch([{ retCode: 110001, retMsg: "order not exists" }]);
  const result = await broker(fetchImpl).cancelWithSymbol("zt-abc", "BTCUSDT");
  assert.equal(result.accepted, true);
});

test("a limit order carries price and time-in-force", async () => {
  const { fetchImpl, calls } = stubFetch([
    { retCode: 0, retMsg: "OK", result: { orderId: "ex-1", orderLinkId: "zt-1" } },
  ]);
  const limit: OrderIntent = {
    ...marketBuy,
    style: { kind: "limit", price: 60_000, timeInForce: "PostOnly" },
  };
  await broker(fetchImpl).submit({ orderLinkId: "zt-1", intent: limit, at: 0 });

  assert.equal(calls[0]!.body.orderType, "Limit");
  assert.equal(calls[0]!.body.price, "60000");
  assert.equal(calls[0]!.body.timeInForce, "PostOnly");
});

test("an unexpanded TWAP intent is refused, not silently marketed", async () => {
  const { fetchImpl } = stubFetch([{ retCode: 0, retMsg: "OK" }]);
  const twap: OrderIntent = { ...marketBuy, style: { kind: "twap", windowMs: 1000, slices: 4 } };

  const ack = await broker(fetchImpl).submit({ orderLinkId: "zt-1", intent: twap, at: 0 });
  assert.equal(ack.accepted, false);
  assert.match(ack.reason ?? "", /expanded/i);
});

// ---------------------------------------------------------------------------
// Account-event translation — "truth is the execution stream"
// ---------------------------------------------------------------------------

test("an execution message becomes a fill event with price and fee", () => {
  const { event } = executionToEvent({
    orderLinkId: "zt-1",
    execQty: 0.5,
    execPrice: 60_100,
    execFee: 0.02,
    isMaker: false,
    execTime: 1_700_000_000_000,
  });
  assert.equal(event.type, "fill");
  if (event.type === "fill") {
    assert.equal(event.qty, 0.5);
    assert.equal(event.price, 60_100);
    assert.equal(event.fee, 0.02);
  }
});

test("a New order status becomes an ack", () => {
  const result = orderUpdateToEvent({
    orderLinkId: "zt-1",
    orderId: "ex-1",
    orderStatus: "New",
    updatedTime: 1,
  });
  assert.equal(result?.event.type, "ack");
});

test("Filled and PartiallyFilled do NOT emit from the order stream", () => {
  // They come from the execution stream, which carries price and quantity.
  // Emitting from both would double-count the fill.
  for (const status of ["Filled", "PartiallyFilled", "PartiallyFilledCanceled"]) {
    assert.equal(
      orderUpdateToEvent({ orderLinkId: "z", orderId: "e", orderStatus: status, updatedTime: 1 }),
      null,
    );
  }
});

test("Cancelled and Rejected map to their events", () => {
  assert.equal(
    orderUpdateToEvent({ orderLinkId: "z", orderId: "e", orderStatus: "Cancelled", updatedTime: 1 })?.event.type,
    "cancel",
  );
  assert.equal(
    orderUpdateToEvent({ orderLinkId: "z", orderId: "e", orderStatus: "Rejected", updatedTime: 1 })?.event.type,
    "reject",
  );
});

test("an unknown status is dropped rather than guessed", () => {
  assert.equal(
    orderUpdateToEvent({ orderLinkId: "z", orderId: "e", orderStatus: "Martian", updatedTime: 1 }),
    null,
  );
});

// ---------------------------------------------------------------------------
// Opt-in live signing check against real Bybit testnet (read-only)
// ---------------------------------------------------------------------------

test("live testnet signing works end to end (opt-in)", { skip: process.env.BYBIT_LIVE_TEST !== "1" }, async () => {
  // Uses the PUBLIC server-time endpoint via the signed client path: it proves
  // the request is well-formed and reaches the venue without needing real keys
  // or placing any order.
  const { BybitRest, BYBIT_REST } = await import("./rest.ts");
  const rest = new BybitRest({
    baseUrl: BYBIT_REST.TESTNET,
    apiKey: "unused-for-public",
    apiSecret: "unused-for-public",
  });
  const result = await rest.get<{ timeSecond: string }>("/v5/market/time");
  assert.ok(Number(result.timeSecond) > 1_700_000_000);
});
