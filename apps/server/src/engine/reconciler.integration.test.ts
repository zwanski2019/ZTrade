import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end proof that an open trade actually settles.
 *
 * The unit tests cover the arithmetic in isolation; this one exercises the real
 * path — SQLite row in, reconciler run, SQLite row out — because the bug that
 * shipped in v0.1 was not bad maths, it was that nothing ever called the close.
 *
 * Env is set before the dynamic imports so `config` picks up a throwaway
 * database rather than the operator's real trade history.
 */
const dir = mkdtempSync(join(tmpdir(), "ztrade-test-"));
process.env.DATABASE_PATH = join(dir, "test.db");
process.env.ZTRADE_AUTH_ENABLED = "false";
process.env.ZTRADE_TRADING_ENABLED = "false";

const { insertTrade, getTrade, openTrades, performanceStats, realisedPnlToday } =
  await import("../db.ts");
const { reconciler, netPnl } = await import("./reconciler.ts");

function openPaperTrade(overrides: Partial<Parameters<typeof insertTrade>[0]> = {}) {
  return insertTrade({
    openedAt: Date.now(),
    closedAt: null,
    symbol: "BTCUSDT",
    side: "LONG",
    size: 0.01,
    entryPrice: 65_000,
    exitPrice: null,
    pnl: 0,
    fees: 0,
    status: "Open",
    closeReason: null,
    strategyId: null,
    exchangeOrderId: null,
    stopLoss: 64_000,
    takeProfit: 66_000,
    paper: true,
    ...overrides,
  });
}

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("an open paper trade is left alone while price sits inside the bracket", async () => {
  const trade = openPaperTrade();

  const settled = await reconciler.reconcilePaper(new Map([["BTCUSDT", 65_100]]));

  assert.equal(settled.length, 0);
  assert.equal(getTrade(trade.id)?.status, "Open");
});

test("a paper trade closes at the take-profit and records a positive P&L", async () => {
  const trade = openPaperTrade({ symbol: "ETHUSDT", entryPrice: 2_000, size: 1, stopLoss: 1_900, takeProfit: 2_100 });

  const settled = await reconciler.reconcilePaper(new Map([["ETHUSDT", 2_150]]));
  assert.equal(settled.length, 1);

  const closed = getTrade(trade.id)!;
  assert.equal(closed.status, "Filled");
  assert.equal(closed.closeReason, "TAKE_PROFIT");
  // Fills at the target, not at the overshooting mark price.
  assert.equal(closed.exitPrice, 2_100);
  assert.ok(closed.pnl > 0, `expected profit, got ${closed.pnl}`);
  assert.ok(closed.fees > 0, "fees must be recorded");

  // P&L is net of fees, matching the pure helper exactly.
  const expected = netPnl({ side: "LONG", size: 1, entryPrice: 2_000 }, 2_100);
  assert.ok(Math.abs(closed.pnl - expected) < 1e-9);
  assert.equal(closed.closedAt !== null, true);
});

test("a paper trade closes at the stop and records a loss", async () => {
  const trade = openPaperTrade({ symbol: "SOLUSDT", entryPrice: 100, size: 10, stopLoss: 95, takeProfit: 110 });

  await reconciler.reconcilePaper(new Map([["SOLUSDT", 90]]));

  const closed = getTrade(trade.id)!;
  assert.equal(closed.status, "Filled");
  assert.equal(closed.closeReason, "STOP_LOSS");
  assert.equal(closed.exitPrice, 95);
  assert.ok(closed.pnl < 0, `expected a loss, got ${closed.pnl}`);
});

test("settling is idempotent — a second pass cannot double count", async () => {
  const trade = openPaperTrade({ symbol: "XRPUSDT", entryPrice: 1, size: 100, stopLoss: 0.9, takeProfit: 1.1 });

  const first = await reconciler.reconcilePaper(new Map([["XRPUSDT", 1.2]]));
  const second = await reconciler.reconcilePaper(new Map([["XRPUSDT", 1.2]]));

  assert.equal(first.length, 1);
  assert.equal(second.length, 0, "an already-closed trade must not settle twice");

  const closed = getTrade(trade.id)!;
  assert.equal(closed.pnl, first[0]!.pnl);
});

test("closed trades leave the open set and reach the statistics", async () => {
  const before = openTrades().length;
  openPaperTrade({ symbol: "ADAUSDT", entryPrice: 1, size: 100, stopLoss: 0.9, takeProfit: 1.1 });
  assert.equal(openTrades().length, before + 1);

  await reconciler.reconcilePaper(new Map([["ADAUSDT", 1.5]]));
  assert.equal(openTrades().length, before);

  // The whole point of settling: metrics stop being computed over an empty set.
  const stats = performanceStats();
  assert.ok(stats.totalTrades > 0, "closed trades must reach performanceStats");
  assert.notEqual(realisedPnlToday(), 0, "realised P&L must move the daily total");
});

test("a trade with no mark price is left open rather than guessed at", async () => {
  const trade = openPaperTrade({ symbol: "DOTUSDT" });

  const settled = await reconciler.reconcilePaper(new Map());

  assert.equal(settled.length, 0);
  assert.equal(getTrade(trade.id)?.status, "Open");
});

test("live trades are never settled by the paper reconciler", async () => {
  const trade = openPaperTrade({ symbol: "LINKUSDT", paper: false, stopLoss: 64_000 });

  const settled = await reconciler.reconcilePaper(new Map([["LINKUSDT", 1]]));

  assert.equal(settled.length, 0);
  assert.equal(getTrade(trade.id)?.status, "Open");
});

test("trailing stops ratchet on open trades and persist", async () => {
  const trade = openPaperTrade({
    symbol: "AVAXUSDT",
    entryPrice: 100,
    size: 1,
    stopLoss: 95,
    takeProfit: 200,
  });

  // Price ran to 120; a 5% trail should pull the stop up to 114.
  const moved = reconciler.applyTrailingStops(new Map([["AVAXUSDT", 120]]), 5);
  assert.equal(moved.length, 1);
  assert.equal(getTrade(trade.id)?.stopLoss, 114);

  // Price falls back — the stop must NOT loosen.
  reconciler.applyTrailingStops(new Map([["AVAXUSDT", 100]]), 5);
  assert.equal(getTrade(trade.id)?.stopLoss, 114);
});
