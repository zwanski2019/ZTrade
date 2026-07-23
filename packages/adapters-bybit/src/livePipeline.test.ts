import test from "node:test";
import assert from "node:assert/strict";
import { MemoryJournal, type JournalEntry } from "@ztrade/execution";
import type { Strategy } from "@ztrade/core";
import { BybitLiveBroker } from "./liveBroker.ts";
import { BybitPrivateWs } from "./privateWs.ts";
import { LivePipeline } from "./livePipeline.ts";

/**
 * Pipeline tests wire the real broker (with a stubbed fetch), a memory journal
 * and a no-op private WS, so cold-start recovery and reconciliation can be
 * driven deterministically without a venue.
 */
function stubRest(handler: (path: string, body?: unknown) => unknown): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const result = handler(path, body);
    return { json: async () => ({ retCode: 0, retMsg: "OK", result }) } as Response;
  }) as unknown as typeof fetch;
}

function makeBroker(fetchImpl: typeof fetch): BybitLiveBroker {
  return new BybitLiveBroker({
    baseUrl: "https://api-testnet.bybit.com",
    apiKey: "k",
    apiSecret: "s",
    tradingEnabled: true,
    fetchImpl,
    now: () => 1_700_000_000_000,
  });
}

function noopPrivateWs(): BybitPrivateWs {
  return new BybitPrivateWs({
    url: "wss://x",
    apiKey: "k",
    apiSecret: "s",
    socketFactory: () => ({
      send: () => {},
      close: () => {},
      onOpen: () => {},
      onMessage: () => {},
      onClose: () => {},
      onError: () => {},
    }),
    onAccountEvent: () => {},
  });
}

const noopStrategy: Strategy = {
  id: "noop@1",
  symbols: ["BTCUSDT"],
  onEvent: () => [],
};

function pipeline(opts: {
  fetchImpl: typeof fetch;
  journal?: MemoryJournal;
}): LivePipeline {
  return new LivePipeline({
    strategy: noopStrategy,
    broker: makeBroker(opts.fetchImpl),
    privateWs: noopPrivateWs(),
    journal: opts.journal ?? new MemoryJournal(),
    now: () => 1_700_000_000_000,
  });
}

// ---------------------------------------------------------------------------
// Account-event journalling
// ---------------------------------------------------------------------------

test("handleAccountEvent journals durably, then feeds the broker", async () => {
  const journal = new MemoryJournal();
  const broker = makeBroker(stubRest(() => ({})));
  const p = new LivePipeline({
    strategy: noopStrategy,
    broker,
    privateWs: noopPrivateWs(),
    journal,
    now: () => 1,
  });

  // Seed an order in the engine as if it had been submitted, so the "open"
  // marker can find its symbol/side/qty.
  p.engine.restoreOrders(
    new Map([[
      "zt-1",
      { orderLinkId: "zt-1", exchangeOrderId: null, symbol: "BTCUSDT", side: "buy", qty: 1, filledQty: 0, avgPrice: 0, feesPaid: 0, state: "SUBMITTED", rejectReason: null, revision: 1 },
    ]]),
  );

  p.handleAccountEvent("zt-1", { type: "fill", qty: 1, price: 100, fee: 0.05, isMaker: false }, 5);

  const entries = journal.read();
  // First an "open" marker, then the "event" — both before the broker sees it.
  assert.equal(entries[0]!.t, "open");
  assert.equal(entries[1]!.t, "event");

  // The event reached the broker's outbox, which the engine drains on tick.
  const drained = broker.drainEvents();
  assert.equal(drained.length, 1);
  assert.equal(drained[0]!.event.type, "fill");
});

test("the open marker is journalled only once per order", () => {
  const journal = new MemoryJournal();
  const p = pipeline({ fetchImpl: stubRest(() => ({})), journal });
  p.engine.restoreOrders(
    new Map([[
      "zt-1",
      { orderLinkId: "zt-1", exchangeOrderId: null, symbol: "BTCUSDT", side: "buy", qty: 1, filledQty: 0, avgPrice: 0, feesPaid: 0, state: "SUBMITTED", rejectReason: null, revision: 1 },
    ]]),
  );

  p.handleAccountEvent("zt-1", { type: "ack", exchangeOrderId: "e" }, 1);
  p.handleAccountEvent("zt-1", { type: "fill", qty: 1, price: 100, fee: 0, isMaker: false }, 2);

  const opens = journal.read().filter((e) => e.t === "open");
  assert.equal(opens.length, 1);
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

test("reconciliation with matching state is clean", async () => {
  const p = pipeline({
    fetchImpl: stubRest((path) => {
      if (path === "/v5/order/realtime") return { list: [] };
      if (path === "/v5/position/list") return { list: [] };
      return {};
    }),
  });
  assert.equal(await p.runReconciliation(), true);
  assert.equal(p.stats.corrections, 0);
});

test("a position the exchange holds but the engine does not is corrected", async () => {
  const p = pipeline({
    fetchImpl: stubRest((path) => {
      if (path === "/v5/order/realtime") return { list: [] };
      if (path === "/v5/position/list") {
        return { list: [{ symbol: "BTCUSDT", side: "Buy", size: "0.5", avgPrice: "60000" }] };
      }
      return {};
    }),
  });

  assert.equal(p.engine.positionOf("BTCUSDT"), 0);
  const clean = await p.runReconciliation();

  assert.equal(clean, false);
  // The engine is corrected TOWARD the exchange — that is where the money is.
  assert.equal(p.engine.positionOf("BTCUSDT"), 0.5);
  assert.equal(p.stats.corrections, 1);
});

test("a short position is corrected with the right sign", async () => {
  const p = pipeline({
    fetchImpl: stubRest((path) => {
      if (path === "/v5/order/realtime") return { list: [] };
      if (path === "/v5/position/list") {
        return { list: [{ symbol: "ETHUSDT", side: "Sell", size: "2", avgPrice: "1800" }] };
      }
      return {};
    }),
  });
  await p.runReconciliation();
  assert.equal(p.engine.positionOf("ETHUSDT"), -2);
});

// ---------------------------------------------------------------------------
// Cold start — gate #6
// ---------------------------------------------------------------------------

test("GATE #6: cold start rebuilds from the journal and reconciles before trading", async () => {
  const journal = new MemoryJournal();
  const seed: JournalEntry[] = [
    { t: "open", at: 1, orderLinkId: "zt-1", symbol: "BTCUSDT", side: "buy", qty: 1 },
    { t: "event", at: 2, orderLinkId: "zt-1", event: { type: "submit" } },
    { t: "event", at: 3, orderLinkId: "zt-1", event: { type: "fill", qty: 1, price: 100, fee: 0, isMaker: false } },
  ];
  for (const e of seed) journal.append(e);

  // The exchange agrees: it holds the 1 BTC the journal implies.
  const p = pipeline({
    journal,
    fetchImpl: stubRest((path) => {
      if (path === "/v5/order/realtime") return { list: [] };
      if (path === "/v5/position/list") {
        return { list: [{ symbol: "BTCUSDT", side: "Buy", size: "1", avgPrice: "100" }] };
      }
      return {};
    }),
  });

  // Before cold start: trading is blocked (fail-closed).
  assert.equal(p.canTrade, false);

  const result = await p.coldStart();
  assert.equal(result.recovered, 1);
  assert.equal(result.reconciled, true);
  assert.equal(p.canTrade, true, "trading enabled only after reconciliation");
  assert.equal(p.engine.positionOf("BTCUSDT"), 1);
});

test("GATE #6: cold start FAILS CLOSED when reconciliation cannot complete", async () => {
  const journal = new MemoryJournal();
  journal.append({ t: "open", at: 1, orderLinkId: "zt-1", symbol: "BTCUSDT", side: "buy", qty: 1 });

  // The exchange pull throws — a network failure during recovery.
  const failing = (async () => {
    throw new Error("network down during cold start");
  }) as unknown as typeof fetch;

  const p = pipeline({ journal, fetchImpl: failing });
  const result = await p.coldStart();

  assert.equal(result.reconciled, false);
  // The gate stays CLOSED: a recovery we could not verify must not trade.
  assert.equal(p.canTrade, false);
});

test("cold start corrects toward the exchange when the journal disagrees", async () => {
  // The journal thinks we hold 1 BTC, but the exchange shows flat — a fill we
  // journalled that was actually cancelled, or a manual close while we were down.
  const journal = new MemoryJournal();
  journal.append({ t: "open", at: 1, orderLinkId: "zt-1", symbol: "BTCUSDT", side: "buy", qty: 1 });
  journal.append({ t: "event", at: 2, orderLinkId: "zt-1", event: { type: "submit" } });
  journal.append({ t: "event", at: 3, orderLinkId: "zt-1", event: { type: "fill", qty: 1, price: 100, fee: 0, isMaker: false } });

  const p = pipeline({
    journal,
    fetchImpl: stubRest((path) => {
      if (path === "/v5/order/realtime") return { list: [] };
      if (path === "/v5/position/list") return { list: [] }; // exchange is flat
      return {};
    }),
  });

  await p.coldStart();
  assert.equal(p.engine.positionOf("BTCUSDT"), 0, "corrected to the exchange's flat");
  assert.equal(p.canTrade, true);
});
