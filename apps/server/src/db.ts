import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type {
  AuditEntry,
  CloseReason,
  EquityPoint,
  PerformanceStats,
  Signal,
  StrategyConfig,
  SymbolStats,
  Trade,
  TradeStatus,
} from "@ztrade/shared";
import { defaultRiskLimits } from "@ztrade/shared";
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

CREATE TABLE IF NOT EXISTS audit_log (
  id     TEXT PRIMARY KEY,
  at     INTEGER NOT NULL,
  action TEXT    NOT NULL,
  detail TEXT    NOT NULL,
  actor  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
`);

/**
 * Additive migrations.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so each column is checked against
 * PRAGMA table_info first. Additive-only by design: an existing trade database
 * is real money history and must never be dropped to accommodate a schema change.
 */
function addColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn("trades", "fees", "REAL NOT NULL DEFAULT 0");
addColumn("trades", "close_reason", "TEXT");
addColumn("trades", "stop_loss", "REAL");
addColumn("trades", "take_profit", "REAL");
addColumn("trades", "paper", "INTEGER NOT NULL DEFAULT 0");
addColumn("signals", "skipped_reason", "TEXT");

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
  fees: number;
  status: string;
  close_reason: string | null;
  strategy_id: string | null;
  exchange_order_id: string | null;
  stop_loss: number | null;
  take_profit: number | null;
  paper: number;
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
    fees: r.fees ?? 0,
    status: r.status as TradeStatus,
    closeReason: (r.close_reason as CloseReason | null) ?? null,
    strategyId: r.strategy_id,
    exchangeOrderId: r.exchange_order_id,
    stopLoss: r.stop_loss,
    takeProfit: r.take_profit,
    paper: r.paper === 1,
  };
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

const insertTradeStmt = db.prepare(`
  INSERT INTO trades (id, opened_at, closed_at, symbol, side, size, entry_price,
                      exit_price, pnl, fees, status, close_reason, strategy_id,
                      exchange_order_id, stop_loss, take_profit, paper)
  VALUES (@id, @opened_at, @closed_at, @symbol, @side, @size, @entry_price,
          @exit_price, @pnl, @fees, @status, @close_reason, @strategy_id,
          @exchange_order_id, @stop_loss, @take_profit, @paper)
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
    fees: trade.fees,
    status: trade.status,
    close_reason: trade.closeReason,
    strategy_id: trade.strategyId,
    exchange_order_id: trade.exchangeOrderId,
    stop_loss: trade.stopLoss,
    take_profit: trade.takeProfit,
    paper: trade.paper ? 1 : 0,
  };
  insertTradeStmt.run(row);
  return toTrade(row);
}

const closeTradeStmt = db.prepare(`
  UPDATE trades
  SET closed_at = @closed_at, exit_price = @exit_price, pnl = @pnl,
      fees = @fees, close_reason = @close_reason, status = 'Filled'
  WHERE id = @id AND closed_at IS NULL
`);

/**
 * Settles an open trade. The `closed_at IS NULL` guard makes this idempotent:
 * the reconciler and a manual close can race, and closing twice would double
 * count the P&L.
 */
export function closeTrade(opts: {
  id: string;
  closedAt: number;
  exitPrice: number;
  pnl: number;
  fees: number;
  reason: CloseReason;
}): Trade | null {
  const result = closeTradeStmt.run({
    id: opts.id,
    closed_at: opts.closedAt,
    exit_price: opts.exitPrice,
    pnl: opts.pnl,
    fees: opts.fees,
    close_reason: opts.reason,
  });
  if (result.changes === 0) return null;
  return getTrade(opts.id);
}

export function updateTradeProtection(
  id: string,
  stopLoss: number | null,
  takeProfit: number | null,
): void {
  db.prepare(`UPDATE trades SET stop_loss = ?, take_profit = ? WHERE id = ?`).run(
    stopLoss,
    takeProfit,
    id,
  );
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

export function openTrades(): Trade[] {
  const rows = db
    .prepare(`SELECT * FROM trades WHERE closed_at IS NULL AND status = 'Open'`)
    .all() as TradeRow[];
  return rows.map(toTrade);
}

export function openTradeForSymbol(symbol: string): Trade | null {
  const row = db
    .prepare(
      `SELECT * FROM trades WHERE symbol = ? AND closed_at IS NULL AND status = 'Open'
       ORDER BY opened_at DESC LIMIT 1`,
    )
    .get(symbol) as TradeRow | undefined;
  return row ? toTrade(row) : null;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

const insertSignalStmt = db.prepare(`
  INSERT INTO signals (id, at, symbol, action, reason, confidence, acted, skipped_reason)
  VALUES (@id, @at, @symbol, @action, @reason, @confidence, @acted, @skipped_reason)
`);

export function insertSignal(signal: Omit<Signal, "id"> & { id?: string }): Signal {
  const full: Signal = { ...signal, id: signal.id ?? randomUUID() };
  insertSignalStmt.run({
    id: full.id,
    at: full.at,
    symbol: full.symbol,
    action: full.action,
    reason: full.reason,
    confidence: full.confidence,
    acted: full.acted ? 1 : 0,
    skipped_reason: full.skippedReason,
  });
  return full;
}

export function markSignalActed(
  id: string,
  acted: boolean,
  skippedReason: string | null,
): void {
  db.prepare(`UPDATE signals SET acted = ?, skipped_reason = ? WHERE id = ?`).run(
    acted ? 1 : 0,
    skippedReason,
    id,
  );
}

export function recentSignals(limit = 20): Signal[] {
  const rows = db
    .prepare(`SELECT * FROM signals ORDER BY at DESC LIMIT ?`)
    .all(limit) as Array<{
    id: string;
    at: number;
    symbol: string;
    action: "BUY" | "SELL";
    reason: string;
    confidence: number;
    acted: number;
    skipped_reason: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    symbol: r.symbol,
    action: r.action,
    reason: r.reason,
    confidence: r.confidence,
    acted: r.acted === 1,
    skippedReason: r.skipped_reason,
  }));
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
    // Merge over defaults so strategies saved before newer risk fields existed
    // still load with sane values instead of undefined.
    risk: { ...defaultRiskLimits, ...(JSON.parse(r.risk) as StrategyConfig["risk"]) },
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

export function latestEquity(): number | null {
  const row = db
    .prepare(`SELECT equity FROM equity_points ORDER BY at DESC LIMIT 1`)
    .get() as { equity: number } | undefined;
  return row?.equity ?? null;
}

// ---------------------------------------------------------------------------
// Settings (key/value)
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
// Audit log
// ---------------------------------------------------------------------------

// Hash-chained, tamper-evident audit log: h_n = SHA256(h_{n-1} || entry). Any
// edit, deletion or reorder of history breaks the chain at a reportable index.
addColumn("audit_log", "prev_hash", "TEXT");
addColumn("audit_log", "hash", "TEXT");

const AUDIT_GENESIS = "0".repeat(64);

function auditCanonical(entry: AuditEntry, seq: number): string {
  return JSON.stringify([seq, entry.at, entry.action, entry.detail, entry.actor ?? null]);
}

function auditHash(prevHash: string, entry: AuditEntry, seq: number): string {
  return createHash("sha256").update(prevHash).update(auditCanonical(entry, seq)).digest("hex");
}

/**
 * Current chain head. Both the seq and the head hash are computed over the
 * CHAINED entries only (hash IS NOT NULL), so they match exactly what
 * verifyAuditChain iterates — entries written before chaining existed do not
 * shift the sequence and break every subsequent hash.
 */
function auditHead(): { hash: string; seq: number } {
  const count = (
    db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE hash IS NOT NULL`).get() as { n: number }
  ).n;
  const last = db
    .prepare(`SELECT hash FROM audit_log WHERE hash IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
    .get() as { hash: string | null } | undefined;
  return { hash: last?.hash ?? AUDIT_GENESIS, seq: count };
}

export function recordAudit(action: string, detail: string, actor: string | null): AuditEntry {
  const entry: AuditEntry = {
    id: randomUUID(),
    at: Date.now(),
    action,
    detail,
    actor,
  };
  const { hash: prevHash, seq } = auditHead();
  const hash = auditHash(prevHash, entry, seq);
  db.prepare(
    `INSERT INTO audit_log (id, at, action, detail, actor, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(entry.id, entry.at, entry.action, entry.detail, entry.actor, prevHash, hash);
  return entry;
}

export function listAudit(limit = 100): AuditEntry[] {
  return db
    .prepare(`SELECT id, at, action, detail, actor FROM audit_log ORDER BY at DESC LIMIT ?`)
    .all(limit) as AuditEntry[];
}

/**
 * Verifies the entire audit chain and reports the first divergence. Recomputes
 * each entry's hash from its predecessor: an edit changes the content hash, a
 * reorder or deletion breaks the linkage. Entries written before hash-chaining
 * was added (prev_hash NULL) are skipped from the verified span.
 */
export function verifyAuditChain(): {
  valid: boolean;
  length: number;
  head: string;
  brokenAt?: number;
  reason?: string;
} {
  const rows = db
    .prepare(
      `SELECT id, at, action, detail, actor, prev_hash, hash FROM audit_log
       WHERE hash IS NOT NULL ORDER BY rowid ASC`,
    )
    .all() as Array<AuditEntry & { prev_hash: string | null; hash: string }>;

  let prevHash = AUDIT_GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.prev_hash !== prevHash) {
      return { valid: false, length: rows.length, head: prevHash, brokenAt: i, reason: "linkage broken (reordered or removed)" };
    }
    const expected = auditHash(prevHash, row, i);
    if (row.hash !== expected) {
      return { valid: false, length: rows.length, head: prevHash, brokenAt: i, reason: "entry modified after it was written" };
    }
    prevHash = row.hash;
  }
  return { valid: true, length: rows.length, head: prevHash };
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
      `SELECT pnl, fees FROM trades
       WHERE status = 'Filled' AND closed_at IS NOT NULL
         AND opened_at >= ? AND opened_at <= ?
       ORDER BY opened_at ASC`,
    )
    .all(from ?? 0, to ?? Number.MAX_SAFE_INTEGER) as Array<{
    pnl: number;
    fees: number;
  }>;

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
      totalFees: 0,
      longestWinStreak: 0,
      longestLossStreak: 0,
      expectancy: 0,
    };
  }

  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const netPnl = pnls.reduce((a, b) => a + b, 0);

  const mean = netPnl / totalTrades;
  const variance = pnls.reduce((acc, p) => acc + (p - mean) ** 2, 0) / totalTrades;
  const stdev = Math.sqrt(variance);

  // Max drawdown across the cumulative P&L path.
  let peak = 0;
  let cumulative = 0;
  let maxDrawdown = 0;
  // Longest runs of wins and losses.
  let winStreak = 0;
  let lossStreak = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;

  for (const p of pnls) {
    cumulative += p;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);

    if (p > 0) {
      winStreak += 1;
      lossStreak = 0;
      longestWinStreak = Math.max(longestWinStreak, winStreak);
    } else if (p < 0) {
      lossStreak += 1;
      winStreak = 0;
      longestLossStreak = Math.max(longestLossStreak, lossStreak);
    }
  }

  const winRate = wins.length / totalTrades;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? -grossLoss / losses.length : 0;

  return {
    winRate,
    avgWin,
    avgLoss,
    profitFactor:
      grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    sharpeRatio: stdev === 0 ? 0 : mean / stdev,
    totalTrades,
    netPnl,
    maxDrawdown,
    totalFees: rows.reduce((a, r) => a + (r.fees ?? 0), 0),
    longestWinStreak,
    longestLossStreak,
    // Expected value per trade: what one more trade is worth on average.
    expectancy: winRate * avgWin + (1 - winRate) * avgLoss,
  };
}

export function symbolStats(from?: number, to?: number): SymbolStats[] {
  const rows = db
    .prepare(
      `SELECT symbol,
              COUNT(*)                                   AS trades,
              SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)   AS wins,
              SUM(pnl)                                   AS net_pnl
       FROM trades
       WHERE status = 'Filled' AND closed_at IS NOT NULL
         AND opened_at >= ? AND opened_at <= ?
       GROUP BY symbol
       ORDER BY net_pnl DESC`,
    )
    .all(from ?? 0, to ?? Number.MAX_SAFE_INTEGER) as Array<{
    symbol: string;
    trades: number;
    wins: number;
    net_pnl: number;
  }>;

  return rows.map((r) => ({
    symbol: r.symbol,
    trades: r.trades,
    winRate: r.trades > 0 ? r.wins / r.trades : 0,
    netPnl: r.net_pnl,
  }));
}

/** Start of the current UTC day, in epoch millis. */
export function startOfUtcDay(now = Date.now()): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** Trades opened since 00:00 UTC — enforces RiskLimits.maxTradesPerDay. */
export function tradesOpenedToday(): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM trades WHERE opened_at >= ?`)
      .get(startOfUtcDay()) as { n: number }
  ).n;
}

/** Realised P&L for trades CLOSED since 00:00 UTC — drives the circuit breaker. */
export function realisedPnlToday(): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS total FROM trades
       WHERE status = 'Filled' AND closed_at >= ?`,
    )
    .get(startOfUtcDay()) as { total: number };
  return row.total;
}

/** Number of losing trades at the tail of the closed-trade history. */
export function consecutiveLosses(): number {
  const rows = db
    .prepare(
      `SELECT pnl FROM trades WHERE status = 'Filled' AND closed_at IS NOT NULL
       ORDER BY closed_at DESC LIMIT 50`,
    )
    .all() as Array<{ pnl: number }>;

  let streak = 0;
  for (const row of rows) {
    if (row.pnl < 0) streak += 1;
    else break;
  }
  return streak;
}
