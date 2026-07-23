import test from "node:test";
import assert from "node:assert/strict";
import type { OrderEvent } from "@ztrade/execution";
import type { SocketLike } from "@ztrade/ingestion";
import { BybitPrivateWs } from "./privateWs.ts";

/**
 * The private WS is driven through a mock socket so the connect sequence —
 * auth → arm dead-man → subscribe — and the reconnect re-arming can be
 * asserted exactly. Gate #2 lives or dies on that ordering, and a test against
 * a healthy live connection would never exercise the reconnect path where the
 * arming is most likely to be forgotten.
 */
class MockSocket implements SocketLike {
  sent: string[] = [];
  private openH: (() => void) | null = null;
  private msgH: ((d: string) => void) | null = null;
  private closeH: (() => void) | null = null;
  private errH: ((e: Error) => void) | null = null;

  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.closeH?.();
  }
  onOpen(h: () => void): void {
    this.openH = h;
  }
  onMessage(h: (d: string) => void): void {
    this.msgH = h;
  }
  onClose(h: () => void): void {
    this.closeH = h;
  }
  onError(h: (e: Error) => void): void {
    this.errH = h;
  }

  open(): void {
    this.openH?.();
  }
  deliver(o: unknown): void {
    this.msgH?.(JSON.stringify(o));
  }
  kill(): void {
    this.closeH?.();
  }
  fail(m: string): void {
    this.errH?.(new Error(m));
  }

  ops(): Array<{ op?: string; args?: unknown }> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

interface Harness {
  ws: BybitPrivateWs;
  sockets: MockSocket[];
  events: Array<{ orderLinkId: string; event: OrderEvent; at: number }>;
  latest(): MockSocket;
}

function harness(): Harness {
  const sockets: MockSocket[] = [];
  const events: Harness["events"] = [];
  const ws = new BybitPrivateWs({
    url: "wss://test/private",
    apiKey: "key",
    apiSecret: "secret",
    socketFactory: () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    },
    onAccountEvent: (orderLinkId, event, at) => events.push({ orderLinkId, event, at }),
    now: () => 1_700_000_000_000,
    reconnectDelayMs: 1,
  });
  ws.start();
  return { ws, sockets, events, latest: () => sockets.at(-1)! };
}

test("authenticates on open with the GET/realtime scheme", () => {
  const h = harness();
  h.latest().open();

  const auth = h.latest().ops()[0]!;
  assert.equal(auth.op, "auth");
  const args = auth.args as [string, number, string];
  assert.equal(args[0], "key");
  assert.match(args[2], /^[0-9a-f]{64}$/, "signature must be a hex HMAC");
});

test("GATE #2: dead-man switch is armed AFTER auth and BEFORE subscribe", () => {
  const h = harness();
  h.latest().open();
  h.latest().deliver({ op: "auth", success: true });

  const ops = h.latest().ops().map((o) => o.op);
  // The exact order is the safety property: from the first order onward, a
  // dropped connection auto-cancels. Arming after subscribe would leave a
  // window where a fill could occur unprotected.
  assert.deepEqual(ops, ["auth", "set_dcp", "subscribe"]);
});

test("GATE #2: the subscribe covers order, execution, position and wallet", () => {
  const h = harness();
  h.latest().open();
  h.latest().deliver({ op: "auth", success: true });

  const sub = h.latest().ops().find((o) => o.op === "subscribe")!;
  assert.deepEqual(sub.args, ["order", "execution", "position", "wallet"]);
  assert.equal(h.ws.isReady, true);
});

test("an auth rejection does not spin and does not arm the switch", () => {
  const h = harness();
  h.latest().open();
  h.latest().deliver({ op: "auth", success: false, ret_msg: "invalid api key" });

  assert.equal(h.ws.connectionState, "ERROR");
  assert.equal(h.ws.stats.authFailures, 1);
  assert.equal(h.ws.stats.deadMansArmed, 0);
  // No subscribe was attempted on rejected auth.
  assert.equal(h.latest().ops().some((o) => o.op === "subscribe"), false);
});

test("GATE #2: a reconnect re-authenticates AND re-arms the dead-man switch", async () => {
  const h = harness();
  h.latest().open();
  h.latest().deliver({ op: "auth", success: true });
  assert.equal(h.ws.stats.deadMansArmed, 1);

  // The venue tied the previous arming to the connection that just dropped.
  h.latest().kill();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(h.sockets.length, 2, "a new socket must be created");
  h.latest().open();
  h.latest().deliver({ op: "auth", success: true });

  assert.equal(h.ws.stats.deadMansArmed, 2, "the switch must be re-armed on reconnect");
  assert.deepEqual(h.latest().ops().map((o) => o.op), ["auth", "set_dcp", "subscribe"]);
});

test("an execution message becomes a fill account-event", () => {
  const h = harness();
  h.latest().open();
  h.latest().deliver({ op: "auth", success: true });

  h.latest().deliver({
    topic: "execution",
    data: [{
      symbol: "BTCUSDT",
      orderLinkId: "zt-1",
      execId: "e1",
      execQty: "0.5",
      execPrice: "60100",
      execFee: "0.02",
      isMaker: false,
      execTime: "1700000000500",
    }],
  });

  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.orderLinkId, "zt-1");
  assert.equal(h.events[0]!.event.type, "fill");
  if (h.events[0]!.event.type === "fill") {
    assert.equal(h.events[0]!.event.price, 60100);
    assert.equal(h.events[0]!.event.qty, 0.5);
  }
});

test("an order status update becomes an ack/cancel event", () => {
  const h = harness();
  h.latest().open();
  h.latest().deliver({ op: "auth", success: true });

  h.latest().deliver({
    topic: "order",
    data: [{
      symbol: "BTCUSDT",
      orderId: "ex-1",
      orderLinkId: "zt-1",
      orderStatus: "New",
      side: "Buy",
      qty: "1",
      cumExecQty: "0",
      updatedTime: "1700000000600",
    }],
  });

  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.event.type, "ack");
});

test("a Filled order status emits nothing (fills come from the execution stream)", () => {
  const h = harness();
  h.latest().open();
  h.latest().deliver({ op: "auth", success: true });

  h.latest().deliver({
    topic: "order",
    data: [{
      symbol: "BTCUSDT", orderId: "ex-1", orderLinkId: "zt-1", orderStatus: "Filled",
      side: "Buy", qty: "1", cumExecQty: "1", updatedTime: "1700000000700",
    }],
  });

  assert.equal(h.events.length, 0, "double-counting fills would corrupt the position");
});

test("position updates flow to the position callback", () => {
  const positions: Array<{ symbol: string; size: number; side: string }> = [];
  const sockets: MockSocket[] = [];
  const ws = new BybitPrivateWs({
    url: "wss://test/private",
    apiKey: "k",
    apiSecret: "s",
    socketFactory: () => {
      const sock = new MockSocket();
      sockets.push(sock);
      return sock;
    },
    onAccountEvent: () => {},
    onPosition: (symbol, size, side) => positions.push({ symbol, size, side }),
    now: () => 1,
  });
  ws.start();
  sockets[0]!.open();
  sockets[0]!.deliver({ op: "auth", success: true });
  sockets[0]!.deliver({
    topic: "position",
    data: [{ symbol: "BTCUSDT", side: "Buy", size: "0.5", entryPrice: "60000" }],
  });

  assert.deepEqual(positions, [{ symbol: "BTCUSDT", size: 0.5, side: "Buy" }]);
});

test("malformed data frames are counted and dropped", () => {
  const h = harness();
  h.latest().open();
  h.latest().deliver({ op: "auth", success: true });

  h.latest().deliver({ topic: "execution", data: [{ orderLinkId: "zt-1" }] }); // missing fields
  assert.equal(h.events.length, 0);
  assert.ok(h.ws.stats.invalid >= 1);
});

test("control frames (subscribe ack, pong, set_dcp ack) are ignored cleanly", () => {
  const h = harness();
  h.latest().open();
  h.latest().deliver({ op: "auth", success: true });
  const before = h.ws.stats.invalid;

  h.latest().deliver({ op: "subscribe", success: true });
  h.latest().deliver({ op: "pong" });
  h.latest().deliver({ op: "set_dcp", success: true });

  assert.equal(h.ws.stats.invalid, before, "control frames must not count as invalid");
});
