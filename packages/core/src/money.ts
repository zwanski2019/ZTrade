import { Decimal, dec, type RoundingMode } from "./decimal.ts";

/**
 * Exact money operations built on Decimal.
 *
 * These replace the float-based sizing and P&L arithmetic. Every one is exact:
 * the classic traps — `0.3 / 0.1` flooring to 2, `100.5 * 0.01` dust,
 * fee accumulation drifting a cent per trade — cannot occur here.
 *
 * Inputs accept `string | number | Decimal`. A string from the exchange is the
 * ideal input (exact by construction); a number is lifted via its shortest
 * round-tripping form, which is exact for any value that began as a decimal.
 */
type Num = string | number | Decimal;

function toDecimal(value: Num): Decimal {
  return value instanceof Decimal ? value : dec(value);
}

/**
 * Rounds an order quantity DOWN to the instrument's step size.
 *
 * Down, always: rounding up could push the order past the notional or risk
 * limit that was just approved. This is the exact replacement for the
 * `Math.floor(qty / step + epsilon)` hack — no epsilon, because integer-unit
 * arithmetic cannot produce the 2.9999… that made the hack necessary.
 */
export function roundQtyDown(qty: Num, step: Num): Decimal {
  return toDecimal(qty).roundToStep(toDecimal(step), "DOWN");
}

/** Rounds a price to the instrument's tick, nearest by default. */
export function roundToTick(price: Num, tick: Num, mode: RoundingMode = "HALF_UP"): Decimal {
  return toDecimal(price).roundToStep(toDecimal(tick), mode);
}

/**
 * Base-asset quantity for a notional at a price, rounded down to step.
 *
 * The order-sizing primitive. Exact end to end: notional/price to a working
 * precision, then floored to the step. Returns zero when the inputs cannot
 * produce a positive, legal quantity.
 */
export function quantityForNotional(notional: Num, price: Num, step: Num): Decimal {
  const p = toDecimal(price);
  const n = toDecimal(notional);
  const s = toDecimal(step);
  if (p.sign() <= 0 || n.sign() <= 0 || s.sign() <= 0) return Decimal.zero();

  // Divide to enough precision that the subsequent floor-to-step is exact —
  // the step's scale plus a margin covers every representable step size.
  const raw = n.div(p, s.scale + 8, "DOWN");
  return raw.roundToStep(s, "DOWN");
}

/** Order value: price × quantity. Exact. */
export function notionalOf(price: Num, qty: Num): Decimal {
  return toDecimal(price).mul(toDecimal(qty));
}

/**
 * Gross P&L for a position, in quote currency. Exact.
 *
 * LONG profits when exit > entry; SHORT is the inverse. No fees here — see
 * `netPnl`.
 */
export function grossPnl(side: "LONG" | "SHORT", size: Num, entry: Num, exit: Num): Decimal {
  const delta = toDecimal(exit).sub(toDecimal(entry));
  const signed = side === "LONG" ? delta : delta.neg();
  return signed.mul(toDecimal(size));
}

/** Round-trip taker/maker fees on entry and exit notional. Exact. */
export function roundTripFees(size: Num, entry: Num, exit: Num, feeRate: Num): Decimal {
  const s = toDecimal(size);
  const rate = toDecimal(feeRate);
  const entryNotional = toDecimal(entry).mul(s);
  const exitNotional = toDecimal(exit).mul(s);
  return entryNotional.add(exitNotional).mul(rate);
}

/** Realised P&L net of both fees — what actually lands in the account. Exact. */
export function netPnl(
  side: "LONG" | "SHORT",
  size: Num,
  entry: Num,
  exit: Num,
  feeRate: Num,
): Decimal {
  return grossPnl(side, size, entry, exit).sub(roundTripFees(size, entry, exit, feeRate));
}

/**
 * Protective stop and target prices from percentage distances. Exact within
 * the percentage arithmetic; the caller rounds to tick before sending.
 */
export function protectivePrices(
  entry: Num,
  side: "LONG" | "SHORT",
  stopLossPct: Num,
  takeProfitPct: Num,
): { stopLoss: Decimal; takeProfit: Decimal } {
  const e = toDecimal(entry);
  const hundred = dec(100);
  const slFraction = toDecimal(stopLossPct).div(hundred, 12, "HALF_UP");
  const tpFraction = toDecimal(takeProfitPct).div(hundred, 12, "HALF_UP");
  const one = dec(1);

  return side === "LONG"
    ? {
        stopLoss: e.mul(one.sub(slFraction)),
        takeProfit: e.mul(one.add(tpFraction)),
      }
    : {
        stopLoss: e.mul(one.add(slFraction)),
        takeProfit: e.mul(one.sub(tpFraction)),
      };
}
