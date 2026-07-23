import type { CircuitBreakerConfig, CircuitBreakerState } from "@ztrade/shared";
import { defaultCircuitBreaker } from "@ztrade/shared";
import {
  consecutiveLosses,
  getSetting,
  latestEquity,
  realisedPnlToday,
  setSetting,
  startOfUtcDay,
} from "../db.js";
import { bus, logger } from "../bus.js";
import { audit, AuditAction } from "../security/audit.js";

export const CIRCUIT_BREAKER_KEY = "circuit_breaker";
const DAY_START_EQUITY_KEY = "day_start_equity";

interface DayStartEquity {
  day: number;
  equity: number;
}

/**
 * Account-level kill switch that sits above per-trade risk limits.
 *
 * Per-trade limits cap the damage of any ONE trade; this caps the damage of a
 * bad day. Ten trades each losing an "acceptable" 1% is still a 10% drawdown,
 * and no per-trade rule can see that coming.
 *
 * Tripping halts new entries and starts a cooldown. It does not flatten open
 * positions unless flattenOnTrip is set — closing into a spike is often worse
 * than holding through it, so that stays the operator's choice.
 */
class CircuitBreaker {
  private tripped = false;
  private reason: string | null = null;
  private trippedAt: number | null = null;
  private resumeAt: number | null = null;

  get config(): CircuitBreakerConfig {
    return getSetting<CircuitBreakerConfig>(CIRCUIT_BREAKER_KEY, defaultCircuitBreaker);
  }

  setConfig(next: CircuitBreakerConfig): void {
    setSetting(CIRCUIT_BREAKER_KEY, next);
  }

  /**
   * Equity at 00:00 UTC, used as the denominator for the daily loss percentage.
   * Recorded once per day; without it a loss percentage would drift as equity
   * changes during the session.
   */
  dayStartEquity(currentEquity: number): number {
    const today = startOfUtcDay();
    const stored = getSetting<DayStartEquity | null>(DAY_START_EQUITY_KEY, null);

    if (stored && stored.day === today && stored.equity > 0) return stored.equity;

    const equity = currentEquity > 0 ? currentEquity : (latestEquity() ?? 0);
    if (equity > 0) setSetting(DAY_START_EQUITY_KEY, { day: today, equity });
    return equity;
  }

  getState(currentEquity = 0): CircuitBreakerState {
    return {
      tripped: this.tripped,
      reason: this.reason,
      trippedAt: this.trippedAt,
      resumeAt: this.resumeAt,
      consecutiveLosses: consecutiveLosses(),
      realisedPnlToday: realisedPnlToday(),
      dayStartEquity: this.dayStartEquity(currentEquity),
    };
  }

  /**
   * Evaluates the breaker. Returns true when trading is halted.
   * Call before opening any position, and after every trade closes.
   */
  evaluate(currentEquity = 0): boolean {
    const cfg = this.config;

    // Expire the cooldown first, so a disabled-then-re-enabled breaker does not
    // stay latched forever.
    if (this.tripped && this.resumeAt !== null && Date.now() >= this.resumeAt) {
      this.reset("cooldown elapsed");
    }

    if (!cfg.enabled) return false;
    if (this.tripped) return true;

    const losses = consecutiveLosses();
    if (cfg.maxConsecutiveLosses > 0 && losses >= cfg.maxConsecutiveLosses) {
      this.trip(`${losses} consecutive losing trades`, cfg);
      return true;
    }

    const pnlToday = realisedPnlToday();
    const startEquity = this.dayStartEquity(currentEquity);
    if (cfg.maxDailyLossPct > 0 && startEquity > 0 && pnlToday < 0) {
      const lossPct = (Math.abs(pnlToday) / startEquity) * 100;
      if (lossPct >= cfg.maxDailyLossPct) {
        this.trip(
          `Daily loss ${lossPct.toFixed(2)}% exceeded limit ${cfg.maxDailyLossPct}%`,
          cfg,
        );
        return true;
      }
    }

    return false;
  }

  private trip(reason: string, cfg: CircuitBreakerConfig): void {
    this.tripped = true;
    this.reason = reason;
    this.trippedAt = Date.now();
    this.resumeAt =
      cfg.cooldownMinutes > 0 ? Date.now() + cfg.cooldownMinutes * 60_000 : null;

    logger.error(`CIRCUIT BREAKER TRIPPED — ${reason}`);
    audit(AuditAction.CIRCUIT_BREAKER_TRIP, reason);
    bus.emitEvent({ type: "circuitBreaker", payload: this.getState() });
  }

  reset(why = "manual reset"): void {
    if (!this.tripped) return;

    this.tripped = false;
    this.reason = null;
    this.trippedAt = null;
    this.resumeAt = null;

    logger.warn(`Circuit breaker reset (${why})`);
    audit(AuditAction.CIRCUIT_BREAKER_RESET, why);
    bus.emitEvent({ type: "circuitBreaker", payload: this.getState() });
  }

  get isTripped(): boolean {
    return this.tripped;
  }

  get trippedReason(): string | null {
    return this.reason;
  }
}

export const circuitBreaker = new CircuitBreaker();

/**
 * Pure helper so the trip conditions can be tested without touching the
 * database or the singleton's latched state.
 */
export function shouldTrip(
  cfg: CircuitBreakerConfig,
  input: { consecutiveLosses: number; realisedPnlToday: number; dayStartEquity: number },
): string | null {
  if (!cfg.enabled) return null;

  if (cfg.maxConsecutiveLosses > 0 && input.consecutiveLosses >= cfg.maxConsecutiveLosses) {
    return `${input.consecutiveLosses} consecutive losing trades`;
  }

  if (cfg.maxDailyLossPct > 0 && input.dayStartEquity > 0 && input.realisedPnlToday < 0) {
    const lossPct = (Math.abs(input.realisedPnlToday) / input.dayStartEquity) * 100;
    if (lossPct >= cfg.maxDailyLossPct) {
      return `Daily loss ${lossPct.toFixed(2)}% exceeded limit ${cfg.maxDailyLossPct}%`;
    }
  }

  return null;
}
