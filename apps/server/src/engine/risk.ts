import type { Position, RiskLimits, StrategyConfig } from "@ztrade/shared";
import { tradesOpenedToday } from "../db.js";

export interface RiskContext {
  strategy: StrategyConfig;
  openPositions: Position[];
  accountEquity: number;
  /** Intended notional for the new position, in quote currency. */
  intendedNotional: number;
  symbol: string;
}

export type RiskVerdict =
  | { allowed: true; notional: number }
  | { allowed: false; reason: string };

/**
 * Single choke point for "may we open this position?".
 *
 * Checks run cheapest-first and are all hard denials rather than warnings — a
 * risk limit the operator set in the UI should never be merely advisory. The
 * one soft behaviour is sizing: an oversized request is clamped down to the
 * limit instead of being rejected outright.
 */
export function assessRisk(ctx: RiskContext): RiskVerdict {
  const limits: RiskLimits = ctx.strategy.risk;

  if (limits.maxTradesPerDay > 0 && tradesOpenedToday() >= limits.maxTradesPerDay) {
    return {
      allowed: false,
      reason: `Daily trade cap reached (${limits.maxTradesPerDay})`,
    };
  }

  // One position per symbol: the engine has no averaging-in logic, so a second
  // entry would silently change the effective entry price of the first.
  if (ctx.openPositions.some((p) => p.symbol === ctx.symbol)) {
    return { allowed: false, reason: `Position already open on ${ctx.symbol}` };
  }

  if (!ctx.strategy.pairs.includes(ctx.symbol)) {
    return { allowed: false, reason: `${ctx.symbol} is not in the allowed pairs list` };
  }

  const currentExposure = ctx.openPositions.reduce(
    (sum, p) => sum + p.entryPrice * p.size,
    0,
  );

  if (currentExposure >= limits.globalRiskCap) {
    return {
      allowed: false,
      reason:
        `Global risk cap reached: ${currentExposure.toFixed(2)} of ` +
        `${limits.globalRiskCap.toFixed(2)} already at risk`,
    };
  }

  // Clamp to whichever ceiling binds first: per-position size, remaining global
  // headroom, or the account's actual equity.
  const headroom = limits.globalRiskCap - currentExposure;
  const notional = Math.min(
    ctx.intendedNotional,
    limits.maxPositionSize,
    headroom,
    ctx.accountEquity,
  );

  if (notional <= 0) {
    return { allowed: false, reason: "No capital available for a new position" };
  }

  return { allowed: true, notional };
}

/**
 * Converts a notional in quote currency to a base-asset quantity, rounded down
 * to the instrument's step size. Rounding down matters: rounding up can push
 * the order past the risk limit that was just approved.
 */
export function quantityFor(notional: number, price: number, stepSize = 0.001): number {
  if (price <= 0 || stepSize <= 0) return 0;

  const raw = notional / price;

  // Nudge before flooring: an exact multiple can land just under itself in
  // binary float (0.3 / 0.1 === 2.9999999999999996), which would silently drop
  // a whole step. The epsilon is relative so it stays negligible at any scale,
  // and far too small to push a genuine remainder up to the next step.
  const ratio = raw / stepSize;
  const steps = Math.floor(ratio + Math.max(1, ratio) * Number.EPSILON * 4);
  const qty = steps * stepSize;

  // Guard against binary-float dust, e.g. 0.30000000000000004.
  const decimals = Math.max(0, Math.ceil(-Math.log10(stepSize)));
  return Number(qty.toFixed(decimals));
}

/** Stop-loss / take-profit prices derived from the strategy's percentages. */
export function protectivePrices(
  entryPrice: number,
  side: "LONG" | "SHORT",
  limits: RiskLimits,
): { stopLoss: number; takeProfit: number } {
  const slFraction = limits.stopLossPct / 100;
  const tpFraction = limits.takeProfitPct / 100;

  return side === "LONG"
    ? {
        stopLoss: entryPrice * (1 - slFraction),
        takeProfit: entryPrice * (1 + tpFraction),
      }
    : {
        stopLoss: entryPrice * (1 + slFraction),
        takeProfit: entryPrice * (1 - tpFraction),
      };
}
