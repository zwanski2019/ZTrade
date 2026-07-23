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

/** Why a position left the book — drives analytics and the close notification. */
export type CloseReason =
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "TRAILING_STOP"
  | "SIGNAL"
  | "MANUAL"
  | "EMERGENCY"
  | "EXCHANGE";

/** Execution engine state — drives the RUNNING / STOP BOT controls. */
export type EngineState = "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "ERROR";

/** Which Bybit environment the engine is pointed at. */
export type Network = "TESTNET" | "MAINNET";

export type StrategyKind = "MOMENTUM" | "MEAN_REVERSION" | "GRID" | "CUSTOM";

/** How a position's size is derived. */
export type SizingMode = "FIXED_NOTIONAL" | "PERCENT_EQUITY" | "RISK_BASED";

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
  /** Realised P&L in quote currency, net of fees. Zero for cancelled trades. */
  pnl: number;
  /** Total fees paid across entry and exit. */
  fees: number;
  status: TradeStatus;
  closeReason: CloseReason | null;
  strategyId: string | null;
  /** Bybit order id, when the trade reached the exchange. */
  exchangeOrderId: string | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** True when this trade was simulated rather than sent to the exchange. */
  paper: boolean;
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
  /** Why the signal was skipped, when acted is false. */
  skippedReason: string | null;
}

/**
 * Exchange-published trading rules for one instrument.
 *
 * Order quantities must be a multiple of qtyStep and clear both minOrderQty and
 * minNotional, or Bybit rejects the order outright.
 */
export interface InstrumentInfo {
  symbol: string;
  tickSize: number;
  qtyStep: number;
  minOrderQty: number;
  maxOrderQty: number;
  /** Minimum order value in quote currency. */
  minNotional: number;
  maxLeverage: number;
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

  /** How position size is derived. Defaults to FIXED_NOTIONAL. */
  sizingMode: SizingMode;
  /** For PERCENT_EQUITY: fraction of equity per position, e.g. 5 === 5%. */
  equityPct: number;
  /** For RISK_BASED: percent of equity risked between entry and stop. */
  riskPerTradePct: number;

  /** Trailing stop distance as a percentage; 0 disables trailing. */
  trailingStopPct: number;
  /** Max concurrent open positions across all symbols. */
  maxOpenPositions: number;
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
// Circuit breaker — account-level fail-safes above per-trade risk
// ---------------------------------------------------------------------------

export interface CircuitBreakerConfig {
  enabled: boolean;
  /** Halt if realised loss today exceeds this percent of starting equity. */
  maxDailyLossPct: number;
  /** Halt after this many consecutive losing trades. 0 disables. */
  maxConsecutiveLosses: number;
  /** Minutes to stay halted once tripped. */
  cooldownMinutes: number;
  /** Also flatten open positions when tripped, not just stop opening new ones. */
  flattenOnTrip: boolean;
}

export interface CircuitBreakerState {
  tripped: boolean;
  reason: string | null;
  trippedAt: number | null;
  /** Epoch millis the cooldown expires; null when not tripped. */
  resumeAt: number | null;
  consecutiveLosses: number;
  realisedPnlToday: number;
  /** Equity at the start of the current UTC day, used for the loss percentage. */
  dayStartEquity: number;
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
  totalFees: number;
  /** Longest run of consecutive wins and losses. */
  longestWinStreak: number;
  longestLossStreak: number;
  expectancy: number;
}

export interface SymbolStats {
  symbol: string;
  trades: number;
  winRate: number;
  netPnl: number;
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

/** Immutable record of a security- or money-relevant action. */
export interface AuditEntry {
  id: string;
  at: number;
  action: string;
  detail: string;
  /** Source IP, when the action arrived over HTTP. */
  actor: string | null;
}

export interface EngineStatus {
  state: EngineState;
  network: Network;
  /** True once market data is flowing from Bybit. */
  exchangeConnected: boolean;
  /** True when API credentials are present AND accepted. */
  credentialsValid: boolean;
  /** Round-trip latency to Bybit in milliseconds; null when disconnected. */
  latencyMs: number | null;
  activeStrategyId: string | null;
  activeStrategyName: string | null;
  /** Epoch millis of the last engine heartbeat. */
  lastHeartbeat: number | null;
  startedAt: number | null;
  /** Populated when state === "ERROR". */
  error: string | null;
  /** False when the engine is in paper mode. */
  tradingEnabled: boolean;
  circuitBreaker: CircuitBreakerState;
  openPositionCount: number;
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
  credentialsValid: boolean;
  tradingEnabled: boolean;
}

export interface UiSettings {
  highContrast: boolean;
}

export interface Settings {
  exchange: ExchangeSettings;
  telegram: TelegramSettings;
  ui: UiSettings;
  circuitBreaker: CircuitBreakerConfig;
}

// ---------------------------------------------------------------------------
// Realtime channel (server -> web terminal)
// ---------------------------------------------------------------------------

export type ServerEvent =
  | { type: "status"; payload: EngineStatus }
  | { type: "account"; payload: AccountSnapshot }
  | { type: "position"; payload: Position | null }
  | { type: "positions"; payload: Position[] }
  | { type: "signal"; payload: Signal }
  | { type: "trade"; payload: Trade }
  | { type: "log"; payload: LogEntry }
  | { type: "circuitBreaker"; payload: CircuitBreakerState }
  | { type: "heartbeat"; payload: { at: number; latencyMs: number | null } };

/** Everything the dashboard needs on first paint, in one round trip. */
export interface DashboardSnapshot {
  status: EngineStatus;
  account: AccountSnapshot;
  position: Position | null;
  positions: Position[];
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

export const defaultRiskLimits: RiskLimits = {
  maxPositionSize: 100,
  stopLossPct: 2,
  takeProfitPct: 4,
  maxTradesPerDay: 10,
  globalRiskCap: 500,
  sizingMode: "FIXED_NOTIONAL",
  equityPct: 5,
  riskPerTradePct: 1,
  trailingStopPct: 0,
  maxOpenPositions: 3,
};

export const defaultCircuitBreaker: CircuitBreakerConfig = {
  enabled: true,
  maxDailyLossPct: 5,
  maxConsecutiveLosses: 4,
  cooldownMinutes: 60,
  flattenOnTrip: false,
};

// ---------------------------------------------------------------------------
// Market intelligence
// ---------------------------------------------------------------------------

/** How the market is behaving right now, independent of direction. */
export type MarketRegime =
  | "TRENDING"
  | "RANGING"
  | "VOLATILE"
  | "TRANSITIONAL"
  | "UNKNOWN";

/** Inputs to the composite conviction score. Nulls mean "data unavailable". */
export interface ConvictionInput {
  action: "BUY" | "SELL";
  /** The strategy's own confidence, 0..1. */
  signalConfidence: number;
  regime: MarketRegime;
  /** +1 uptrend, -1 downtrend, 0 sideways. */
  regimeDirection: number;
  /** Perpetual funding rate as a fraction; positive means longs pay shorts. */
  fundingRate: number | null;
  /** Fear & Greed index, 0..100. */
  fearGreed: number | null;
  /** Percentage change in open interest over the recent window. */
  openInterestChangePct: number | null;
}

export interface ConvictionScore {
  /** 0..1 composite. */
  score: number;
  passed: boolean;
  reasons: string[];
  components: {
    signal: number;
    regime: number;
    funding: number;
    sentiment: number;
    openInterest: number;
  };
}

/** Per-symbol intelligence gathered from free public sources. */
export interface SymbolIntel {
  symbol: string;
  regime: MarketRegime;
  adx: number;
  /** ATR as a fraction of price. */
  volatility: number;
  direction: number;
  fundingRate: number | null;
  openInterest: number | null;
  openInterestChangePct: number | null;
  longShortRatio: number | null;
  /** Median price across independent venues, when available. */
  consensusPrice: number | null;
  /** Our venue's deviation from consensus, in basis points. */
  consensusDeviationBps: number | null;
}

export interface MarketIntel {
  at: number;
  fearGreed: { value: number; classification: string } | null;
  btcDominance: number | null;
  totalMarketCapUsd: number | null;
  marketCapChangePct24h: number | null;
  symbols: SymbolIntel[];
  /** Rolling return correlation between traded pairs, keyed "A|B". */
  correlations: Record<string, number>;
  /** Providers that failed on the last refresh. */
  degraded: string[];
}

export interface IntelSettings {
  enabled: boolean;
  /** Block strategies whose kind does not suit the current regime. */
  regimeFilter: boolean;
  /** Require the composite conviction score to clear its threshold. */
  convictionFilter: boolean;
  /** Scale position size by conviction (never above the risk-approved size). */
  convictionSizing: boolean;
  /** Derive stop distance from ATR instead of the fixed percentage. */
  volatilityStops: boolean;
  /** ATR multiple used for volatility stops. */
  atrStopMultiplier: number;
  /** Block a new position correlated above this with an existing one. */
  maxCorrelation: number;
  /** Refuse to trade when our price deviates from consensus by more than this. */
  maxConsensusDeviationBps: number;
}

export const defaultIntelSettings: IntelSettings = {
  enabled: true,
  regimeFilter: true,
  convictionFilter: true,
  convictionSizing: true,
  volatilityStops: false,
  atrStopMultiplier: 2,
  maxCorrelation: 0.85,
  maxConsensusDeviationBps: 100,
};
