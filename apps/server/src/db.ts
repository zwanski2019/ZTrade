import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  EquityPoint,
  PerformanceStats,
  Signal,
  StrategyConfig,
  Trade,
  TradeStatus,
} from "@ztrade/shared";
import { config } from "./config.js";

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS trades (
  id                TEXT PRIMARY KEY,
  opened_at         INTEGER NOT NULL,
  closed_at         INTEGER,
  symbol            TEXT    NOT NULL,
  side              TEXT    NOT NULL CHECK (side IN ('LONG','SHORT')),
  size              REAL    NOT NULL,
  entry_price       REAL    NOT NULL,
  exit_price        REAL,
  pnl               REAL    NOT NULL DEFAULT 0,
  status            TEXT    NOT NULL,
  strategy_id       TEXT,
  exchange_order_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades(opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_status    ON trades(status);

CREATE TABLE IF NOT EXISTS signals (
  id         TEXT PRIMARY KEY,
  at         INTEGER NOT NULL,
  symbol     TEXT    NOT NULL,
  action     TEXT    NOT NULL CHECK (action IN ('BUY','SELL')),
  reason     TEXT    NOT NULL,
  confidence REAL    NOT NULL,
  acted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_signals_at ON signals(at DESC);

CREATE TABLE IF NOT EXISTS strategies (
  id         TEXT PRIMARY KEY,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  pairs      TEXT    NOT NULL,
  risk       TEXT    NOT NULL,
  params     TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS equity_points (
  at     INTEGER PRIMARY KEY,
  equity REAL NOT NULL,
  pnl    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

interface TradeRow {
  id: string;
  opened_at: number;
  closed_at: number | null;
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  entry_price: number;
  exit_price: number | null;
  pnl: number;
  status: string;
  strategy_id: string | null;
  exchange_order_id: string | null;
}

function toTrade(r: TradeRow): Trade {
  return {
    id: r.id,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    symbol: r.symbol,
    side: r.side,
    size: r.size,
    entryPrice: r.entry_price,
    exitPrice: r.exit_price,
    pnl: r.pnl,
    status: r.status as TradeStatus,
    strategyId: r.strategy_id,
    exchangeOrderId: r.exchange_order_id,
  };
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

const insertTradeStmt = db.prepare(`
  INSERT INTO trades (id, opened_at, closed_at, symbol, side, size, entry_price,
                      exit_price, pnl, status, strategy_id, exchange_order_id)
  VALUES (@id, @opened_at, @closed_at, @symbol, @side, @size, @entry_price,
          @exit_price, @pnl, @status, @strategy_id, @exchange_order_id)
`);

export function insertTrade(trade: Omit<Trade, "id"> & { id?: string }): Trade {
  const row: TradeRow = {
    id: trade.id ?? randomUUID(),
    opened_at: trade.openedAt,
    closed_at: trade.closedAt,
    symbol: trade.symbol,
    side: trade.side,
    size: trade.size,
    entry_price: trade.entryPrice,
    exit_price: trade.exitPrice,
    pnl: trade.pnl,
    status: trade.status,
    strategy_id: trade.strategyId,
    exchange_order_id: trade.exchangeOrderId,
  };
  insertTradeStmt.run(row);
  return toTrade(row);
}

const closeTradeStmt = db.prepare(`
  UPDATE trades SET closed_at = ?, exit_price = ?, pnl = ?, status = 'Filled'
  WHERE id = ?
`);

export function closeTrade(
  id: string,
  closedAt: number,
  exitPrice: number,
  pnl: number,
): Trade | null {
  closeTradeStmt.run(closedAt, exitPrice, pnl, id);
  return getTrade(id);
}

const getTradeStmt = db.prepare(`SELECT * FROM trades WHERE id = ?`);

export function getTrade(id: string): Trade | null {
  const row = getTradeStmt.get(id) as TradeRow | undefined;
  return row ? toTrade(row) : null;
}

export interface TradeQuery {
  limit?: number;
  offset?: number;
  status?: TradeStatus | "All";
  symbol?: string;
  /** Free-text match against the symbol column. */
  search?: string;
  from?: number;
  to?: number;
}

export function listTrades(q: TradeQuery = {}): { trades: Trade[]; total: number } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (q.status && q.status !== "All") {
    where.push("status = @status");
    params.status = q.status;
  }
  if (q.symbol) {
    where.push("symbol = @symbol");
    params.symbol = q.symbol;
  }
  if (q.search) {
    where.push("symbol LIKE @search");
    params.search = `%${q.search.toUpperCase()}%`;
  }
  if (q.from !== undefined) {
    where.push("opened_at >= @from");
    params.from = q.from;
  }
  if (q.to !== undefined) {
    where.push("opened_at <= @to");
    params.to = q.to;
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM trades ${clause}`).get(params) as {
      n: number;
    }
  ).n;

  const rows = db
    .prepare(
      `SELECT * FROM trades ${clause} ORDER BY opened_at DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: q.limit ?? 50, offset: q.offset ?? 0 }) as TradeRow[];

  return { trades: rows.map(toTrade), total };
}

export function recentTrades(limit = 10): Trade[] {
  return listTrades({ limit }).trades;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

const insertSignalStmt = db.prepare(`
  INSERT INTO signals (id, at, symbol, action, reason, confidence, acted)
  VALUES (@id, @at, @symbol, @action, @reason, @confidence, @acted)
`);

export function insertSignal(signal: Omit<Signal, "id"> & { id?: string }): Signal {
  const full: Signal = { ...signal, id: signal.id ?? randomUUID() };
  insertSignalStmt.run({ ...full, acted: full.acted ? 1 : 0 });
  return full;
}

export function recentSignals(limit = 20): Signal[] {
  const rows = db
    .prepare(`SELECT * FROM signals ORDER BY at DESC LIMIT ?`)
    .all(limit) as Array<Omit<Signal, "acted"> & { acted: number }>;
  return rows.map((r) => ({ ...r, acted: r.acted === 1 }));
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

interface StrategyRow {
  id: string;
  name: string;
  kind: string;
  enabled: number;
  pairs: string;
  risk: string;
  params: string;
  updated_at: number;
}

function toStrategy(r: StrategyRow): StrategyConfig {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as StrategyConfig["kind"],
    enabled: r.enabled === 1,
    pairs: JSON.parse(r.pairs) as string[],
    risk: JSON.parse(r.risk) as StrategyConfig["risk"],
    params: JSON.parse(r.params) as StrategyConfig["params"],
    updatedAt: r.updated_at,
  };
}

export function listStrategies(): StrategyConfig[] {
  const rows = db
    .prepare(`SELECT * FROM strategies ORDER BY updated_at DESC`)
    .all() as StrategyRow[];
  return rows.map(toStrategy);
}

export function getStrategy(id: string): StrategyConfig | null {
  const row = db.prepare(`SELECT * FROM strategies WHERE id = ?`).get(id) as
    | StrategyRow
    | undefined;
  return row ? toStrategy(row) : null;
}

export function getActiveStrategy(): StrategyConfig | null {
  const row = db
    .prepare(`SELECT * FROM strategies WHERE enabled = 1 ORDER BY updated_at DESC LIMIT 1`)
    .get() as StrategyRow | undefined;
  return row ? toStrategy(row) : null;
}

const upsertStrategyStmt = db.prepare(`
  INSERT INTO strategies (id, name, kind, enabled, pairs, risk, params, updated_at)
  VALUES (@id, @name, @kind, @enabled, @pairs, @risk, @params, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    name = @name, kind = @kind, enabled = @enabled, pairs = @pairs,
    risk = @risk, params = @params, updated_at = @updated_at
`);

export function upsertStrategy(s: StrategyConfig): StrategyConfig {
  upsertStrategyStmt.run({
    id: s.id,
    name: s.name,
    kind: s.kind,
    enabled: s.enabled ? 1 : 0,
    pairs: JSON.stringify(s.pairs),
    risk: JSON.stringify(s.risk),
    params: JSON.stringify(s.params),
    updated_at: s.updatedAt,
  });
  return s;
}

/** Only one strategy may be armed at a time — the dashboard shows exactly one. */
export const setActiveStrategy = db.transaction((id: string) => {
  db.prepare(`UPDATE strategies SET enabled = 0`).run();
  db.prepare(`UPDATE strategies SET enabled = 1, updated_at = ? WHERE id = ?`).run(
    Date.now(),
    id,
  );
});

export function deleteStrategy(id: string): void {
  db.prepare(`DELETE FROM strategies WHERE id = ?`).run(id);
}

// ---------------------------------------------------------------------------
// Equity curve
// ---------------------------------------------------------------------------

export function recordEquity(point: EquityPoint): void {
  db.prepare(
    `INSERT INTO equity_points (at, equity, pnl) VALUES (?, ?, ?)
     ON CONFLICT(at) DO UPDATE SET equity = excluded.equity, pnl = excluded.pnl`,
  ).run(point.at, point.equity, point.pnl);
}

export function equityCurve(from?: number, to?: number): EquityPoint[] {
  return db
    .prepare(
      `SELECT at, equity, pnl FROM equity_points
       WHERE at >= ? AND at <= ? ORDER BY at ASC`,
    )
    .all(from ?? 0, to ?? Number.MAX_SAFE_INTEGER) as EquityPoint[];
}

// ---------------------------------------------------------------------------
// Settings (key/value; secrets live in .env, not here)
// ---------------------------------------------------------------------------

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/**
 * Performance metrics over closed trades.
 *
 * Sharpe here is a per-trade ratio (mean return / stdev of returns) rather than
 * an annualised figure — the trade log has no fixed sampling interval, so
 * annualising it would imply a precision we do not have.
 */
export function performanceStats(from?: number, to?: number): PerformanceStats {
  const rows = db
    .prepare(
      `SELECT pnl FROM trades
       WHERE status = 'Filled' AND closed_at IS NOT NULL
         AND opened_at >= ? AND opened_at <= ?
       ORDER BY opened_at ASC`,
    )
    .all(from ?? 0, to ?? Number.MAX_SAFE_INTEGER) as Array<{ pnl: number }>;

  const pnls = rows.map((r) => r.pnl);
  const totalTrades = pnls.length;

  if (totalTrades === 0) {
    return {
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      sharpeRatio: 0,
      totalTrades: 0,
      netPnl: 0,
      maxDrawdown: 0,
    };
  }

  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const netPnl = pnls.reduce((a, b) => a + b, 0);

  const mean = netPnl / totalTrades;
  const variance =
    pnls.reduce((acc, p) => acc + (p - mean) ** 2, 0) / totalTrades;
  const stdev = Math.sqrt(variance);

  // Max drawdown across the cumulative P&L path.
  let peak = 0;
  let cumulative = 0;
  let maxDrawdown = 0;
  for (const p of pnls) {
    cumulative += p;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  return {
    winRate: wins.length / totalTrades,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    sharpeRatio: stdev === 0 ? 0 : mean / stdev,
    totalTrades,
    netPnl,
    maxDrawdown,
  };
}

/** Trades opened since 00:00 UTC — enforces RiskLimits.maxTradesPerDay. */
export function tradesOpenedToday(): number {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM trades WHERE opened_at >= ?`)
      .get(startOfDay.getTime()) as { n: number }
  ).n;
}

export function openTrades(): Trade[] {
  const rows = db
    .prepare(`SELECT * FROM trades WHERE closed_at IS NULL AND status = 'Open'`)
    .all() as TradeRow[];
  return rows.map(toTrade);
}
