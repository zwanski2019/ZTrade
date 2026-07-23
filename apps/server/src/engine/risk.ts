import type {
  InstrumentInfo,
  Position,
  RiskLimits,
  StrategyConfig,
} from "@ztrade/shared";
import {
  quantityForNotional,
  roundToTick as roundToTickExact,
  protectivePrices as protectivePricesExact,
} from "@ztrade/core";
import { openTrades, tradesOpenedToday } from "../db.js";

export interface RiskContext {
  strategy: StrategyConfig;
  /** Positions reported by the exchange (empty in paper mode). */
  openPositions: Position[];
  accountEquity: number;
  symbol: string;
  /** Last traded price, used for sizing. */
  price: number;
  instrument: InstrumentInfo;
}

export type RiskVerdict =
  | { allowed: true; notional: number; quantity: number }
  | { allowed: false; reason: string };

/**
 * Single choke point for "may we open this position?".
 *
 * Checks run cheapest-first and are all hard denials rather than warnings — a
 * risk limit the operator set in the UI should never be merely advisory. The
 * one soft behaviour is sizing: an oversized request is clamped down to the
 * limit instead of being rejected outright.
 *
 * Open positions are taken from the exchange AND from open trade rows, because
 * in paper mode the exchange reports nothing — without the second source the
 * bot would happily open the same paper position forever.
 */
export function assessRisk(ctx: RiskContext): RiskVerdict {
  const limits: RiskLimits = ctx.strategy.risk;

  if (!ctx.strategy.pairs.includes(ctx.symbol)) {
    return { allowed: false, reason: `${ctx.symbol} is not in the allowed pairs list` };
  }

  if (limits.maxTradesPerDay > 0 && tradesOpenedToday() >= limits.maxTradesPerDay) {
    return {
      allowed: false,
      reason: `Daily trade cap reached (${limits.maxTradesPerDay})`,
    };
  }

  const bookedSymbols = new Set<string>([
    ...ctx.openPositions.map((p) => p.symbol),
    ...openTrades().map((t) => t.symbol),
  ]);

  // One position per symbol: the engine has no averaging-in logic, so a second
  // entry would silently change the effective entry price of the first.
  if (bookedSymbols.has(ctx.symbol)) {
    return { allowed: false, reason: `Position already open on ${ctx.symbol}` };
  }

  if (limits.maxOpenPositions > 0 && bookedSymbols.size >= limits.maxOpenPositions) {
    return {
      allowed: false,
      reason: `Max concurrent positions reached (${limits.maxOpenPositions})`,
    };
  }

  const exchangeExposure = ctx.openPositions.reduce(
    (sum, p) => sum + p.entryPrice * p.size,
    0,
  );
  const paperExposure = openTrades()
    .filter((t) => !ctx.openPositions.some((p) => p.symbol === t.symbol))
    .reduce((sum, t) => sum + t.entryPrice * t.size, 0);
  const currentExposure = exchangeExposure + paperExposure;

  if (currentExposure >= limits.globalRiskCap) {
    return {
      allowed: false,
      reason:
        `Global risk cap reached: ${currentExposure.toFixed(2)} of ` +
        `${limits.globalRiskCap.toFixed(2)} already at risk`,
    };
  }

  const requested = intendedNotional(limits, ctx.accountEquity);

  // Clamp to whichever ceiling binds first: per-position size, remaining global
  // headroom, or the account's actual equity.
  const headroom = limits.globalRiskCap - currentExposure;
  const candidates = [requested, limits.maxPositionSize, headroom];
  // Equity only constrains sizing once we actually know it; in paper mode with
  // no credentials it is 0 and must not clamp everything to nothing.
  if (ctx.accountEquity > 0) candidates.push(ctx.accountEquity);

  const notional = Math.min(...candidates);
  if (notional <= 0) {
    return { allowed: false, reason: "No capital available for a new position" };
  }

  const quantity = quantityFor(notional, ctx.price, ctx.instrument.qtyStep);

  if (quantity < ctx.instrument.minOrderQty) {
    return {
      allowed: false,
      reason:
        `Size ${quantity} is below the exchange minimum ` +
        `${ctx.instrument.minOrderQty} for ${ctx.symbol}`,
    };
  }

  const actualNotional = quantity * ctx.price;
  if (actualNotional < ctx.instrument.minNotional) {
    return {
      allowed: false,
      reason:
        `Order value ${actualNotional.toFixed(2)} is below the exchange minimum ` +
        `${ctx.instrument.minNotional} for ${ctx.symbol}`,
    };
  }

  if (quantity > ctx.instrument.maxOrderQty) {
    return {
      allowed: false,
      reason: `Size ${quantity} exceeds the exchange maximum for ${ctx.symbol}`,
    };
  }

  return { allowed: true, notional: actualNotional, quantity };
}

/**
 * Notional the strategy wants to commit, before any clamping.
 *
 * RISK_BASED is the one worth explaining: it sizes so that the distance from
 * entry to stop equals `riskPerTradePct` of equity. A tighter stop therefore
 * buys a LARGER position for the same money at risk, which is the whole point —
 * risk stays constant while position size adapts to volatility.
 */
export function intendedNotional(limits: RiskLimits, equity: number): number {
  switch (limits.sizingMode) {
    case "PERCENT_EQUITY":
      return equity > 0 ? equity * (limits.equityPct / 100) : limits.maxPositionSize;

    case "RISK_BASED": {
      if (equity <= 0 || limits.stopLossPct <= 0) return limits.maxPositionSize;
      const riskAmount = equity * (limits.riskPerTradePct / 100);
      return riskAmount / (limits.stopLossPct / 100);
    }

    case "FIXED_NOTIONAL":
    default:
      return limits.maxPositionSize;
  }
}

/**
 * Converts a notional in quote currency to a base-asset quantity, rounded down
 * to the instrument's step size. Rounding down matters: rounding up can push
 * the order past the risk limit that was just approved.
 */
export function quantityFor(notional: number, price: number, stepSize = 0.001): number {
  if (price <= 0 || stepSize <= 0 || !Number.isFinite(notional) || notional <= 0) {
    return 0;
  }
  // Exact decimal arithmetic — no epsilon nudge. The float version needed one
  // because `0.3 / 0.1` floored to 2, dropping a whole step; integer-unit
  // arithmetic in Decimal cannot produce that. See @ztrade/core money helpers.
  return quantityForNotional(notional, price, stepSize).toNumber();
}

/** Rounds a price to the instrument's tick size — Bybit rejects finer prices. */
export function roundToTick(price: number, tickSize: number): number {
  if (tickSize <= 0 || !Number.isFinite(price)) return price;
  return roundToTickExact(price, tickSize, "HALF_UP").toNumber();
}

/** Stop-loss / take-profit prices derived from the strategy's percentages. */
export function protectivePrices(
  entryPrice: number,
  side: "LONG" | "SHORT",
  limits: RiskLimits,
): { stopLoss: number; takeProfit: number } {
  // Exact percentage arithmetic in Decimal, then back to number at the boundary.
  const { stopLoss, takeProfit } = protectivePricesExact(
    entryPrice,
    side,
    limits.stopLossPct,
    limits.takeProfitPct,
  );
  return { stopLoss: stopLoss.toNumber(), takeProfit: takeProfit.toNumber() };
}

/**
 * New trailing-stop level, or null when the stop should not move.
 *
 * A trailing stop only ever ratchets in the profitable direction. Letting it
 * loosen would defeat the purpose — the whole point is that the worst case
 * improves monotonically as the trade goes your way.
 */
export function trailingStopFor(
  side: "LONG" | "SHORT",
  markPrice: number,
  currentStop: number | null,
  trailingPct: number,
): number | null {
  if (trailingPct <= 0 || markPrice <= 0) return null;

  const distance = markPrice * (trailingPct / 100);
  const candidate = side === "LONG" ? markPrice - distance : markPrice + distance;

  if (currentStop === null) return candidate;
  if (side === "LONG") return candidate > currentStop ? candidate : null;
  return candidate < currentStop ? candidate : null;
}
