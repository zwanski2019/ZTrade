/**
 * Shared domain types for ZTrade.
 *
 * These mirror what the Stitch designs actually render, so the server and the
 * web terminal cannot drift apart. See design/reference/*.html.
 */

export type Side = "LONG" | "SHORT";
export type OrderSide = "Buy" | "Sell";

/** Lifecycle of a trade as shown in the Trade Log "Status" column. */
export type TradeStatus = "Filled" | "Open" | "Cancelled" | "Rejected";

/** Execution engine state — drives the RUNNING / STOP BOT controls. */
export type EngineState = "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "ERROR";

/** Which Bybit environment the engine is pointed at. */
export type Network = "TESTNET" | "MAINNET";

export type StrategyKind = "MOMENTUM" | "MEAN_REVERSION" | "GRID" | "CUSTOM";

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

export interface Trade {
  id: string;
  /** Epoch millis the trade was opened. */
  openedAt: number;
  /** Epoch millis the trade was closed; null while still open. */
  closedAt: number | null;
  symbol: string;
  side: Side;
  /** Position size in base asset units. */
  size: number;
  entryPrice: number;
  /** Null while the position is still open. */
  exitPrice: number | null;
  /** Realised P&L in quote currency. Zero for cancelled trades. */
  pnl: number;
  status: TradeStatus;
  strategyId: string | null;
  /** Bybit order id, when the trade reached the exchange. */
  exchangeOrderId: string | null;
}

export interface Position {
  symbol: string;
  side: Side;
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealisedPnl: number;
  /** Unrealised P&L as a fraction of notional (0.003 === 0.3%). */
  unrealisedPnlPct: number;
  leverage: number;
  liquidationPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

/** A row in the dashboard Signal Feed. */
export interface Signal {
  id: string;
  at: number;
  symbol: string;
  action: "BUY" | "SELL";
  /** Human-readable reason, e.g. "RSI CONFIRM", "MACD_CROSS", "OVERBOUGHT". */
  reason: string;
  /** Model confidence 0..1; the UI renders it as a percentage. */
  confidence: number;
  /** True when the signal actually resulted in an order. */
  acted: boolean;
}

// ---------------------------------------------------------------------------
// Strategy configuration (Strategy Config screen)
// ---------------------------------------------------------------------------

export interface RiskLimits {
  /** Max notional per position, in quote currency. */
  maxPositionSize: number;
  /** Stop-loss distance as a percentage, e.g. 2 === 2%. */
  stopLossPct: number;
  /** Take-profit distance as a percentage. */
  takeProfitPct: number;
  /** Hard cap on trades opened per UTC day. */
  maxTradesPerDay: number;
  /** Global ceiling on total simultaneous risk, in quote currency. */
  globalRiskCap: number;
}

export interface StrategyConfig {
  id: string;
  name: string;
  kind: StrategyKind;
  enabled: boolean;
  /** Symbols this strategy may trade, e.g. ["BTCUSDT", "ETHUSDT"]. */
  pairs: string[];
  risk: RiskLimits;
  /** Free-form knobs specific to the strategy kind (period, threshold, ...). */
  params: Record<string, number | string | boolean>;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Analytics (Trade History screen)
// ---------------------------------------------------------------------------

export interface PerformanceStats {
  /** 0..1 — UI renders as a percentage. */
  winRate: number;
  avgWin: number;
  avgLoss: number;
  /** gross profit / gross loss; Infinity when there are no losses. */
  profitFactor: number;
  sharpeRatio: number;
  totalTrades: number;
  netPnl: number;
  maxDrawdown: number;
}

export interface EquityPoint {
  at: number;
  equity: number;
  pnl: number;
}

export interface BacktestResult {
  strategyId: string;
  from: number;
  to: number;
  winRate: number;
  maxDrawdown: number;
  tradesCount: number;
  netPnl: number;
  equityCurve: EquityPoint[];
}

// ---------------------------------------------------------------------------
// System / engine
// ---------------------------------------------------------------------------

export type LogLevel = "INFO" | "WARN" | "ERROR" | "TRADE";

export interface LogEntry {
  id: string;
  at: number;
  level: LogLevel;
  message: string;
}

export interface EngineStatus {
  state: EngineState;
  network: Network;
  /** True once the Bybit REST/WS clients have authenticated. */
  exchangeConnected: boolean;
  /** Round-trip latency to Bybit in milliseconds; null when disconnected. */
  latencyMs: number | null;
  activeStrategyId: string | null;
  activeStrategyName: string | null;
  /** Epoch millis of the last engine heartbeat. */
  lastHeartbeat: number | null;
  startedAt: number | null;
  /** Populated when state === "ERROR". */
  error: string | null;
}

export interface AccountSnapshot {
  /** Total equity in quote currency (USDT). */
  equity: number;
  availableBalance: number;
  /** Session P&L as a fraction, e.g. 0.024 === +2.4%. */
  pnlPct: number;
  unrealisedPnl: number;
}

// ---------------------------------------------------------------------------
// Settings (Settings & API screen)
// ---------------------------------------------------------------------------

export interface TelegramSettings {
  enabled: boolean;
  /** Never returned by the API in full — see maskSecret(). */
  botToken: string | null;
  chatId: string | null;
  notifyTradeOpened: boolean;
  notifyTradeClosed: boolean;
  notifyDailySummary: boolean;
  notifyErrors: boolean;
}

export interface ExchangeSettings {
  network: Network;
  /** Masked on the wire, e.g. "abcd••••••wxyz". */
  apiKeyMasked: string | null;
  hasSecret: boolean;
}

export interface UiSettings {
  highContrast: boolean;
}

export interface Settings {
  exchange: ExchangeSettings;
  telegram: TelegramSettings;
  ui: UiSettings;
}

// ---------------------------------------------------------------------------
// Realtime channel (server -> web terminal)
// ---------------------------------------------------------------------------

export type ServerEvent =
  | { type: "status"; payload: EngineStatus }
  | { type: "account"; payload: AccountSnapshot }
  | { type: "position"; payload: Position | null }
  | { type: "signal"; payload: Signal }
  | { type: "trade"; payload: Trade }
  | { type: "log"; payload: LogEntry }
  | { type: "heartbeat"; payload: { at: number; latencyMs: number | null } };

/** Everything the dashboard needs on first paint, in one round trip. */
export interface DashboardSnapshot {
  status: EngineStatus;
  account: AccountSnapshot;
  position: Position | null;
  signals: Signal[];
  recentTrades: Trade[];
  equityCurve: EquityPoint[];
  stats: PerformanceStats;
}

/** Masks a secret for display: keeps the first/last 4 characters. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(6)}${value.slice(-4)}`;
}
