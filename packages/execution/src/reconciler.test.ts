import test from "node:test";
import assert from "node:assert/strict";
import { positionCorrections, reconcile, type ExchangeOrder, type ExchangePosition } from "./reconciler.ts";
import { newOrder, applyOrderEvent, type OrderRecord } from "./orderState.ts";

function liveOrder(orderLinkId: string): OrderRecord {
  const created = newOrder({ orderLinkId, symbol: "BTCUSDT", side: "buy", qty: 1 });
  const acked = applyOrderEvent(created, { type: "submit" });
  return acked.ok ? acked.order : created;
}

function filledOrder(orderLinkId: string): OrderRecord {
  let o = liveOrder(orderLinkId);
  const filled = applyOrderEvent(o, { type: "fill", qty: 1, price: 100, fee: 0, isMaker: false });
  if (filled.ok) o = filled.order;
  return o;
}

test("matching state reconciles clean", () => {
  const local = new Map([["zt-1", liveOrder("zt-1")]]);
  const positions = new Map([["BTCUSDT", 0.5]]);
  const exOrders: ExchangeOrder[] = [{ orderLinkId: "zt-1", symbol: "BTCUSDT" }];
  const exPositions: ExchangePosition[] = [{ symbol: "BTCUSDT", size: 0.5 }];

  const result = reconcile(local, positions, exOrders, exPositions);
  assert.equal(result.clean, true);
  assert.equal(result.drift.length, 0);
});

test("a phantom order — live locally, absent at the exchange — is flagged", () => {
  // We think it is working; the exchange has never heard of it. Almost always a
  // missed fill or cancel message.
  const local = new Map([["zt-1", liveOrder("zt-1")]]);
  const result = reconcile(local, new Map(), [], []);

  assert.equal(result.clean, false);
  const phantom = result.drift.find((d) => d.kind === "phantom_order");
  assert.ok(phantom);
  assert.equal(phantom!.orderLinkId, "zt-1");
});

test("a terminal order absent at the exchange is NOT a phantom", () => {
  // A filled order is supposed to be gone from the exchange's open list.
  const local = new Map([["zt-1", filledOrder("zt-1")]]);
  const result = reconcile(local, new Map(), [], []);
  assert.equal(result.drift.some((d) => d.kind === "phantom_order"), false);
});

test("an untracked exchange order is flagged — the dangerous direction", () => {
  // The exchange has a live order we know nothing about. It can fill and move
  // our position with the engine none the wiser.
  const exOrders: ExchangeOrder[] = [{ orderLinkId: "manual-1", symbol: "ETHUSDT" }];
  const result = reconcile(new Map(), new Map(), exOrders, []);

  const untracked = result.drift.find((d) => d.kind === "untracked_order");
  assert.ok(untracked);
  assert.equal(untracked!.orderLinkId, "manual-1");
});

test("a position mismatch is flagged and resolves toward the exchange", () => {
  const positions = new Map([["BTCUSDT", 0.5]]);
  const exPositions: ExchangePosition[] = [{ symbol: "BTCUSDT", size: 0.3 }];

  const result = reconcile(new Map(), positions, [], exPositions);
  const mismatch = result.drift.find((d) => d.kind === "position_mismatch");
  assert.ok(mismatch);
  if (mismatch?.kind === "position_mismatch") {
    assert.equal(mismatch.localSize, 0.5);
    assert.equal(mismatch.exchangeSize, 0.3);
  }

  // The correction always adopts the exchange's number — that is where the
  // money actually is.
  const corrections = positionCorrections(result);
  assert.equal(corrections.get("BTCUSDT"), 0.3);
});

test("a position the exchange has but we do not is a mismatch from zero", () => {
  const exPositions: ExchangePosition[] = [{ symbol: "SOLUSDT", size: 2 }];
  const result = reconcile(new Map(), new Map(), [], exPositions);

  const mismatch = result.drift.find((d) => d.kind === "position_mismatch");
  assert.ok(mismatch);
  assert.equal(positionCorrections(result).get("SOLUSDT"), 2);
});

test("a position we think we hold but the exchange has flat corrects to zero", () => {
  const positions = new Map([["BTCUSDT", 0.5]]);
  const result = reconcile(new Map(), positions, [], []);
  assert.equal(positionCorrections(result).get("BTCUSDT"), 0);
});

test("dust-sized differences are tolerated, not flagged", () => {
  const positions = new Map([["BTCUSDT", 0.5]]);
  const exPositions: ExchangePosition[] = [{ symbol: "BTCUSDT", size: 0.5 + 1e-12 }];
  const result = reconcile(new Map(), positions, [], exPositions);
  assert.equal(result.clean, true);
});

test("multiple drifts are all reported in one pass", () => {
  const local = new Map([["zt-phantom", liveOrder("zt-phantom")]]);
  const positions = new Map([["BTCUSDT", 1]]);
  const exOrders: ExchangeOrder[] = [{ orderLinkId: "manual", symbol: "ETHUSDT" }];
  const exPositions: ExchangePosition[] = [{ symbol: "BTCUSDT", size: 0.5 }];

  const result = reconcile(local, positions, exOrders, exPositions);
  const kinds = result.drift.map((d) => d.kind).sort();
  assert.deepEqual(kinds, ["phantom_order", "position_mismatch", "untracked_order"]);
});
