import type { OrderIntent } from "@ztrade/core";
import { CircuitBreaker, blocksNewRisk, type BreakerState } from "./breaker.ts";

/**
 * Independent risk engine (§4.4, ship gate #3).
 *
 * Sits between the strategy and execution. EVERY intent passes through, and a
 * veto is final — a strategy has no path to the broker, so it cannot route
 * around this. That independence is the whole design: a bug in strategy code
 * should be able to lose money slowly, never catastrophically.
 *
 * A vetoed order is a first-class, audited event. Silently dropping an intent
 * is how you end up staring at a strategy that "isn't trading" with no record
 * of why.
 *
 * The engine is a pure function of (intent, state). It performs no I/O and
 * reads no clock — event time is passed in — so it behaves identically in
 * backtest, paper and live.
 */

export interface RiskLimits {
  /** Max notional for a single position, per symbol, in quote currency. */
  maxPositionNotional: number;
  /** Max total notional across every open position. */
  maxAggregateNotional: number;
  /**
   * Max leverage, enforced LOCALLY. Never trust the venue's own cap: it can be
   * changed out of band, and by the time it binds you are already exposed.
   */
  maxLeverage: number;
  /** Realised loss for the day that trips HALT, as a fraction of day-start equity. */
  maxDailyLossPct: number;
  /** Drawdown from the equity high-water mark that trips HALT, as a fraction. */
  maxDrawdownPct: number;
  /** Max combined notional across positions deemed correlated. */
  maxCorrelatedNotional: number;
  /** Correlation at or above this counts as "the same trade". */
  correlationThreshold: number;
  /** Max intents accepted within `rateWindowMs`. Fat-finger burst guard. */
  maxOrdersPerWindow: number;
  rateWindowMs: number;
  /** Reject an order priced more than this fraction away from mid. */
  maxPriceDeviationPct: number;
}

export const DEFAULT_LIMITS: RiskLimits = {
  maxPositionNotional: 1_000,
  maxAggregateNotional: 5_000,
  maxLeverage: 5,
  maxDailyLossPct: 0.05,
  maxDrawdownPct: 0.15,
  maxCorrelatedNotional: 2_000,
  correlationThreshold: 0.8,
  maxOrdersPerWindow: 20,
  rateWindowMs: 60_000,
  maxPriceDeviationPct: 0.05,
};

export interface PortfolioState {
  /** Signed base-asset position per symbol; negative is short. */
  positions: Map<string, number>;
  /** Reference price per symbol, used to value exposure. */
  marks: Map<string, number>;
  equity: number;
  /** Equity at 00:00 UTC — the denominator for the daily loss check. */
  dayStartEquity: number;
  /** Highest equity ever seen — the reference for drawdown. */
  highWaterMark: number;
  /** Realised P&L booked today. */
  realisedPnlToday: number;
  /** Pairwise return correlation, keyed by `correlationKey`. */
  correlations: Map<string, number>;
}

export function emptyPortfolio(equity = 0): PortfolioState {
  return {
    positions: new Map(),
    marks: new Map(),
    equity,
    dayStartEquity: equity,
    highWaterMark: equity,
    realisedPnlToday: 0,
    correlations: new Map(),
  };
}

export function correlationKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

export type RiskCheck =
  | "BREAKER"
  | "POSITION_NOTIONAL"
  | "AGGREGATE_NOTIONAL"
  | "LEVERAGE"
  | "DAILY_LOSS"
  | "DRAWDOWN"
  | "CORRELATION"
  | "ORDER_RATE"
  | "PRICE_BAND"
  | "SANITY";

export type RiskDecision =
  | { allowed: true; intent: OrderIntent }
  | { allowed: false; check: RiskCheck; reason: string; intent: OrderIntent };

export interface RiskContext {
  portfolio: PortfolioState;
  /** Reference price for the intent's symbol. */
  mark: number;
  /** Event time in millis. Never read from a clock. */
  at: number;
}

export class RiskEngine {
  readonly breaker: CircuitBreaker;
  /** Timestamps of recently accepted intents, for the rate check. */
  private recentOrders: number[] = [];
  private readonly decisions: RiskDecision[] = [];

  constructor(
    private readonly limits: RiskLimits = DEFAULT_LIMITS,
    onTransition?: (t: { from: BreakerState; to: BreakerState; reason: string }) => void,
  ) {
    this.breaker = new CircuitBreaker(onTransition);
  }

  get decisionLog(): readonly RiskDecision[] {
    return this.decisions;
  }

  get state(): BreakerState {
    return this.breaker.state;
  }

  /**
   * Evaluates portfolio-level conditions and escalates the breaker.
   *
   * Called before checking intents and after every fill. These are the
   * conditions no per-order check can see: a single order can be perfectly
   * sized while the account is down 8% on the day.
   */
  evaluatePortfolio(portfolio: PortfolioState, at: number): BreakerState {
    if (portfolio.dayStartEquity > 0) {
      const lossPct = -portfolio.realisedPnlToday / portfolio.dayStartEquity;
      if (lossPct >= this.limits.maxDailyLossPct) {
        this.breaker.escalate(
          "HALT",
          `Daily loss ${(lossPct * 100).toFixed(2)}% >= limit ${(this.limits.maxDailyLossPct * 100).toFixed(2)}%`,
          at,
        );
      }
    }

    if (portfolio.highWaterMark > 0) {
      const drawdown = (portfolio.highWaterMark - portfolio.equity) / portfolio.highWaterMark;
      if (drawdown >= this.limits.maxDrawdownPct) {
        this.breaker.escalate(
          "HALT",
          `Drawdown ${(drawdown * 100).toFixed(2)}% from high-water mark >= limit ${(this.limits.maxDrawdownPct * 100).toFixed(2)}%`,
          at,
        );
      }
    }

    return this.breaker.state;
  }

  /** The single choke point. Returns a decision; never throws, never mutates the intent. */
  check(intent: OrderIntent, ctx: RiskContext): RiskDecision {
    const decision = this.evaluate(intent, ctx);
    this.decisions.push(decision);

    // Only accepted orders consume rate budget. Counting rejections would let
    // a misbehaving strategy lock itself out by spamming invalid intents.
    if (decision.allowed) this.recentOrders.push(ctx.at);

    return decision;
  }

  private evaluate(intent: OrderIntent, ctx: RiskContext): RiskDecision {
    const deny = (check: RiskCheck, reason: string): RiskDecision => ({
      allowed: false,
      check,
      reason,
      intent,
    });

    // --- 0. Sanity. Garbage in must not reach any arithmetic below. -------
    if (!Number.isFinite(intent.qty) || intent.qty <= 0) {
      return deny("SANITY", `Invalid quantity ${intent.qty}`);
    }
    if (!Number.isFinite(ctx.mark) || ctx.mark <= 0) {
      return deny("SANITY", `No usable mark price for ${intent.symbol}`);
    }

    // --- 1. Circuit breaker ----------------------------------------------
    // Checked first: when the account is in trouble, nothing else matters.
    if (blocksNewRisk(this.breaker.state) && !intent.reduceOnly) {
      return deny(
        "BREAKER",
        `Circuit breaker is ${this.breaker.state}: ${this.breaker.reason ?? "no new risk"}`,
      );
    }

    const notional = intent.qty * ctx.mark;
    const { portfolio } = ctx;

    // --- 2. Order rate -----------------------------------------------------
    this.pruneRateWindow(ctx.at);
    if (this.recentOrders.length >= this.limits.maxOrdersPerWindow) {
      // A burst is almost never a strategy working correctly; it is a loop bug
      // or a feed glitch, and it is cheap to stop here.
      return deny(
        "ORDER_RATE",
        `${this.recentOrders.length} orders in the last ${this.limits.rateWindowMs}ms >= limit ${this.limits.maxOrdersPerWindow}`,
      );
    }

    // --- 3. Fat-finger price band -----------------------------------------
    const limitPrice = priceOf(intent);
    if (limitPrice !== null) {
      const deviation = Math.abs(limitPrice - ctx.mark) / ctx.mark;
      if (deviation > this.limits.maxPriceDeviationPct) {
        return deny(
          "PRICE_BAND",
          `Price ${limitPrice} is ${(deviation * 100).toFixed(2)}% from mark ${ctx.mark}, limit ${(this.limits.maxPriceDeviationPct * 100).toFixed(2)}%`,
        );
      }
    }

    // A reduce-only order lowers exposure, so the size caps below do not apply.
    if (intent.reduceOnly) return { allowed: true, intent };

    // --- 4. Per-symbol notional -------------------------------------------
    const existing = Math.abs(portfolio.positions.get(intent.symbol) ?? 0) * ctx.mark;
    const projected = existing + notional;
    if (projected > this.limits.maxPositionNotional) {
      return deny(
        "POSITION_NOTIONAL",
        `${intent.symbol} notional would reach ${projected.toFixed(2)}, limit ${this.limits.maxPositionNotional}`,
      );
    }

    // --- 5. Aggregate notional --------------------------------------------
    const aggregate = totalNotional(portfolio) + notional;
    if (aggregate > this.limits.maxAggregateNotional) {
      return deny(
        "AGGREGATE_NOTIONAL",
        `Aggregate notional would reach ${aggregate.toFixed(2)}, limit ${this.limits.maxAggregateNotional}`,
      );
    }

    // --- 6. Leverage, enforced locally ------------------------------------
    if (portfolio.equity > 0) {
      const leverage = aggregate / portfolio.equity;
      if (leverage > this.limits.maxLeverage) {
        return deny(
          "LEVERAGE",
          `Leverage would reach ${leverage.toFixed(2)}x, limit ${this.limits.maxLeverage}x`,
        );
      }
    }

    // --- 7. Correlated exposure -------------------------------------------
    // Five "different" strategies all long BTC-correlated alts is one position
    // at five times the size. The per-symbol cap cannot see it.
    const correlated = correlatedNotional(
      portfolio,
      intent.symbol,
      this.limits.correlationThreshold,
    );
    if (correlated + notional > this.limits.maxCorrelatedNotional) {
      return deny(
        "CORRELATION",
        `Correlated exposure would reach ${(correlated + notional).toFixed(2)}, limit ${this.limits.maxCorrelatedNotional}`,
      );
    }

    return { allowed: true, intent };
  }

  private pruneRateWindow(at: number): void {
    const cutoff = at - this.limits.rateWindowMs;
    // Timestamps are appended in order, so dropping from the front is enough.
    let i = 0;
    while (i < this.recentOrders.length && this.recentOrders[i]! < cutoff) i += 1;
    if (i > 0) this.recentOrders.splice(0, i);
  }
}

function priceOf(intent: OrderIntent): number | null {
  return intent.style.kind === "limit" ? intent.style.price : null;
}

export function totalNotional(portfolio: PortfolioState): number {
  let total = 0;
  for (const [symbol, size] of portfolio.positions) {
    const mark = portfolio.marks.get(symbol);
    if (mark === undefined) continue;
    total += Math.abs(size) * mark;
  }
  return total;
}

/**
 * Notional held in positions correlated with `symbol` at or above the
 * threshold, including any existing position in `symbol` itself.
 */
export function correlatedNotional(
  portfolio: PortfolioState,
  symbol: string,
  threshold: number,
): number {
  let total = 0;

  for (const [held, size] of portfolio.positions) {
    if (size === 0) continue;
    const mark = portfolio.marks.get(held);
    if (mark === undefined) continue;

    if (held === symbol) {
      total += Math.abs(size) * mark;
      continue;
    }

    const correlation = portfolio.correlations.get(correlationKey(symbol, held));
    // Absolute value: a -0.9 correlation held short is the same concentration
    // as +0.9 held long.
    if (correlation !== undefined && Math.abs(correlation) >= threshold) {
      total += Math.abs(size) * mark;
    }
  }

  return total;
}
