import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileJournal,
  MemoryJournal,
  recoverState,
  RecoveryGate,
  type JournalEntry,
} from "./journal.ts";

// ---------------------------------------------------------------------------
// Journal storage
// ---------------------------------------------------------------------------

test("a memory journal round-trips entries in order", () => {
  const j = new MemoryJournal();
  j.append({ t: "open", at: 1, orderLinkId: "zt-1", symbol: "BTCUSDT", side: "buy", qty: 1 });
  j.append({ t: "event", at: 2, orderLinkId: "zt-1", event: { type: "submit" } });

  const read = j.read();
  assert.equal(read.length, 2);
  assert.equal(read[0]!.t, "open");
});

test("a file journal persists across instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "ztrade-journal-"));
  try {
    const path = join(dir, "j.jsonl");
    const a = new FileJournal(path);
    a.append({ t: "open", at: 1, orderLinkId: "zt-1", symbol: "BTCUSDT", side: "buy", qty: 1 });

    // A fresh instance (as after a restart) reads what the first wrote.
    const b = new FileJournal(path);
    const read = b.read();
    assert.equal(read.length, 1);
    const first = read[0]!;
    assert.equal(first.t, "open");
    assert.equal(first.t === "open" ? first.orderLinkId : null, "zt-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn final line is skipped, not fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "ztrade-journal-"));
  try {
    const path = join(dir, "j.jsonl");
    // Simulate a process killed mid-write: a valid line then a truncated one.
    writeFileSync(
      path,
      JSON.stringify({ t: "open", at: 1, orderLinkId: "zt-1", symbol: "BTCUSDT", side: "buy", qty: 1 }) +
        "\n" +
        '{"t":"event","at":2,"orderLi',
    );
    const j = new FileJournal(path);
    const read = j.read();
    assert.equal(read.length, 1, "the torn line is dropped, the good one survives");
    assert.equal(read[0]!.t, "open");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty or missing journal reads as no entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "ztrade-journal-"));
  try {
    assert.deepEqual(new FileJournal(join(dir, "does-not-exist.jsonl")).read(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cold-start recovery — the heart of gate #6
// ---------------------------------------------------------------------------

test("recovery rebuilds an open order from the journal", () => {
  const entries: JournalEntry[] = [
    { t: "open", at: 1, orderLinkId: "zt-1", symbol: "BTCUSDT", side: "buy", qty: 1 },
    { t: "event", at: 2, orderLinkId: "zt-1", event: { type: "submit" } },
    { t: "event", at: 3, orderLinkId: "zt-1", event: { type: "ack", exchangeOrderId: "ex-1" } },
  ];
  const state = recoverState(entries);

  const order = state.orders.get("zt-1");
  assert.ok(order);
  assert.equal(order!.state, "ACK");
  assert.equal(order!.exchangeOrderId, "ex-1");
});

test("recovery derives net position from fills, exactly as the engine does", () => {
  const entries: JournalEntry[] = [
    { t: "open", at: 1, orderLinkId: "zt-buy", symbol: "BTCUSDT", side: "buy", qty: 2 },
    { t: "event", at: 2, orderLinkId: "zt-buy", event: { type: "submit" } },
    { t: "event", at: 3, orderLinkId: "zt-buy", event: { type: "fill", qty: 2, price: 100, fee: 0, isMaker: false } },
    { t: "open", at: 4, orderLinkId: "zt-sell", symbol: "BTCUSDT", side: "sell", qty: 0.5 },
    { t: "event", at: 5, orderLinkId: "zt-sell", event: { type: "submit" } },
    { t: "event", at: 6, orderLinkId: "zt-sell", event: { type: "fill", qty: 0.5, price: 110, fee: 0, isMaker: false } },
  ];
  const state = recoverState(entries);

  // Bought 2, sold 0.5 → net +1.5.
  assert.ok(Math.abs((state.positions.get("BTCUSDT") ?? 0) - 1.5) < 1e-9);
});

test("a fill for an order with no open marker is skipped, not guessed", () => {
  // Without the open marker we do not know the side; assuming one would corrupt
  // the position. Dropping it is the safe choice.
  const entries: JournalEntry[] = [
    { t: "event", at: 1, orderLinkId: "orphan", event: { type: "fill", qty: 5, price: 100, fee: 0, isMaker: false } },
  ];
  const state = recoverState(entries);
  assert.equal(state.positions.size, 0);
  assert.equal(state.orders.size, 0);
});

test("an illegal replay transition keeps prior state rather than throwing", () => {
  const entries: JournalEntry[] = [
    { t: "open", at: 1, orderLinkId: "zt-1", symbol: "BTCUSDT", side: "buy", qty: 1 },
    { t: "event", at: 2, orderLinkId: "zt-1", event: { type: "submit" } },
    { t: "event", at: 3, orderLinkId: "zt-1", event: { type: "fill", qty: 1, price: 100, fee: 0, isMaker: false } },
    // A fill after the order is already FILLED is illegal — must not corrupt state.
    { t: "event", at: 4, orderLinkId: "zt-1", event: { type: "fill", qty: 1, price: 100, fee: 0, isMaker: false } },
  ];
  const state = recoverState(entries);
  assert.equal(state.orders.get("zt-1")!.state, "FILLED");
  assert.ok(Math.abs((state.positions.get("BTCUSDT") ?? 0) - 1) < 1e-9, "no double count");
});

test("the last reconciliation marker is surfaced", () => {
  const entries: JournalEntry[] = [
    { t: "open", at: 1, orderLinkId: "zt-1", symbol: "BTCUSDT", side: "buy", qty: 1 },
    { t: "reconciled", at: 99, detail: "cold start" },
  ];
  assert.equal(recoverState(entries).lastReconciledAt, 99);
});

// ---------------------------------------------------------------------------
// Recovery gate — fails closed
// ---------------------------------------------------------------------------

test("the recovery gate blocks trading until explicitly reconciled", () => {
  const gate = new RecoveryGate();
  // Fresh gate: closed. A bug in the reconcile wiring therefore leaves trading
  // OFF, not on.
  assert.equal(gate.canTrade, false);

  gate.markReconciled();
  assert.equal(gate.canTrade, true);

  gate.block();
  assert.equal(gate.canTrade, false);
});
