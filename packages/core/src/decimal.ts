/**
 * Exact decimal arithmetic — "money is never a float".
 *
 * IEEE-754 doubles cannot represent most decimal fractions: `0.1 + 0.2` is
 * `0.30000000000000004`, and `0.3 / 0.1` floored is `2`, not `3`. On a trading
 * path that turns into a wrong order size, a rejected order, or a P&L that
 * drifts a cent per trade until the books do not reconcile. ZTrade already got
 * bitten by exactly this (the `quantityFor` step-rounding needed an epsilon
 * nudge to stop dropping a whole step).
 *
 * Decimal is backed by a bigint coefficient and an integer scale, so it is
 * EXACT for addition, subtraction and multiplication, and exact for
 * rounding-to-a-step (the operation that actually decides order quantities).
 * Division is the only operation that must be told a target scale and rounding
 * mode, because a repeating decimal has no exact finite form.
 *
 * Deliberately dependency-free: a money type is the last place to trust a
 * transitive npm package in a process holding trading keys.
 */

export type RoundingMode =
  | "DOWN" // truncate toward zero
  | "UP" // away from zero
  | "FLOOR" // toward -infinity
  | "CEIL" // toward +infinity
  | "HALF_UP" // nearest, ties away from zero
  | "HALF_EVEN"; // nearest, ties to even (banker's)

export class Decimal {
  /** value = coefficient * 10^(-scale). scale >= 0. */
  private readonly c: bigint;
  private readonly s: number;

  private constructor(coefficient: bigint, scale: number) {
    this.c = coefficient;
    this.s = scale;
  }

  // --- construction ------------------------------------------------------

  static fromString(input: string): Decimal {
    const str = input.trim();
    if (!/^-?\d+(\.\d+)?$/.test(str)) {
      throw new Error(`Invalid decimal string: "${input}"`);
    }
    const negative = str.startsWith("-");
    const body = negative ? str.slice(1) : str;
    const [intPart, fracPart = ""] = body.split(".");
    const scale = fracPart.length;
    const digits = intPart + fracPart;
    const coefficient = BigInt(digits === "" ? "0" : digits);
    return new Decimal(negative ? -coefficient : coefficient, scale);
  }

  /**
   * From a JS number, via its shortest round-tripping string.
   *
   * `(0.1).toString()` is `"0.1"`, not the full binary expansion, so this is
   * EXACT for any number that originated as a decimal literal or a parsed
   * decimal string — which is every price and size in the system. It rejects
   * NaN/Infinity rather than producing nonsense.
   */
  static fromNumber(n: number): Decimal {
    if (!Number.isFinite(n)) throw new Error(`Cannot make a Decimal from ${n}`);
    return Decimal.fromString(n.toString());
  }

  static fromBigInt(n: bigint): Decimal {
    return new Decimal(n, 0);
  }

  static zero(): Decimal {
    return new Decimal(0n, 0);
  }

  /** Number of fractional digits. */
  get scale(): number {
    return this.s;
  }

  // --- internal alignment ------------------------------------------------

  /** Returns both coefficients raised to a common scale. */
  private static align(a: Decimal, b: Decimal): { ca: bigint; cb: bigint; scale: number } {
    const scale = Math.max(a.s, b.s);
    const ca = a.c * 10n ** BigInt(scale - a.s);
    const cb = b.c * 10n ** BigInt(scale - b.s);
    return { ca, cb, scale };
  }

  // --- exact arithmetic --------------------------------------------------

  add(other: Decimal): Decimal {
    const { ca, cb, scale } = Decimal.align(this, other);
    return new Decimal(ca + cb, scale);
  }

  sub(other: Decimal): Decimal {
    const { ca, cb, scale } = Decimal.align(this, other);
    return new Decimal(ca - cb, scale);
  }

  /** Exact: the product scale is the sum of the operand scales. */
  mul(other: Decimal): Decimal {
    return new Decimal(this.c * other.c, this.s + other.s);
  }

  neg(): Decimal {
    return new Decimal(-this.c, this.s);
  }

  abs(): Decimal {
    return this.c < 0n ? new Decimal(-this.c, this.s) : this;
  }

  /**
   * Division to a fixed scale with a rounding mode. Not exact by nature — you
   * must say how much precision you want and how to break the last digit.
   */
  div(other: Decimal, scale: number, mode: RoundingMode = "HALF_UP"): Decimal {
    if (other.c === 0n) throw new Error("Decimal division by zero");
    // Compute at scale+1 guard digit, then round.
    const guardScale = scale + 1;
    // numerator / denominator at guardScale: (this.c * 10^(guard + other.s - this.s)) / other.c
    const shift = guardScale + other.s - this.s;
    const numerator = shift >= 0 ? this.c * 10n ** BigInt(shift) : this.c;
    const denomShift = shift < 0 ? -shift : 0;
    const denominator = other.c * 10n ** BigInt(denomShift);
    const quotient = numerator / denominator;
    const remainder = numerator - quotient * denominator;
    const guarded = new Decimal(quotient, guardScale);
    return guarded.roundToScale(scale, mode, remainder !== 0n);
  }

  // --- rounding ----------------------------------------------------------

  /** Rounds to `scale` fractional digits with the given mode. */
  roundToScale(scale: number, mode: RoundingMode = "HALF_UP", extraNonZero = false): Decimal {
    if (scale >= this.s) {
      return new Decimal(this.c * 10n ** BigInt(scale - this.s), scale);
    }
    const drop = this.s - scale;
    const divisor = 10n ** BigInt(drop);
    const quotient = this.c / divisor;
    const remainder = this.c - quotient * divisor;
    const rounded = applyRounding(quotient, remainder, divisor, this.c < 0n, mode, extraNonZero);
    return new Decimal(rounded, scale);
  }

  /**
   * Rounds to a multiple of `step` — the operation that decides order sizes.
   *
   * EXACT, no epsilon: works in integer units of the step. This is what
   * replaces the float `Math.floor(x/step + epsilon)` hack. Rounding an exact
   * 0.3 to a step of 0.1 yields exactly 3 units → 0.3, where the float version
   * computed 2.9999… and floored to 2.
   */
  roundToStep(step: Decimal, mode: RoundingMode = "DOWN"): Decimal {
    if (step.c <= 0n) throw new Error("Step must be positive");

    const { ca, cb } = Decimal.align(this, step);
    const quotient = ca / cb;
    const remainder = ca - quotient * cb;
    const units = applyRounding(quotient, remainder, cb, this.c < 0n, mode, false);
    // result = units × step. `units` is an integer count of whole steps, so the
    // value is (units * step.coefficient) at the step's own scale.
    return new Decimal(units * step.c, step.s);
  }

  // --- comparison --------------------------------------------------------

  compare(other: Decimal): -1 | 0 | 1 {
    const { ca, cb } = Decimal.align(this, other);
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    return 0;
  }

  eq(other: Decimal): boolean {
    return this.compare(other) === 0;
  }
  lt(other: Decimal): boolean {
    return this.compare(other) === -1;
  }
  lte(other: Decimal): boolean {
    return this.compare(other) !== 1;
  }
  gt(other: Decimal): boolean {
    return this.compare(other) === 1;
  }
  gte(other: Decimal): boolean {
    return this.compare(other) !== -1;
  }

  isZero(): boolean {
    return this.c === 0n;
  }

  sign(): -1 | 0 | 1 {
    if (this.c < 0n) return -1;
    if (this.c > 0n) return 1;
    return 0;
  }

  min(other: Decimal): Decimal {
    return this.lte(other) ? this : other;
  }
  max(other: Decimal): Decimal {
    return this.gte(other) ? this : other;
  }

  // --- output ------------------------------------------------------------

  toString(): string {
    const negative = this.c < 0n;
    const digits = (negative ? -this.c : this.c).toString();
    if (this.s === 0) return (negative ? "-" : "") + digits;

    const padded = digits.padStart(this.s + 1, "0");
    const intPart = padded.slice(0, padded.length - this.s);
    const fracPart = padded.slice(padded.length - this.s).replace(/0+$/, "");
    const body = fracPart ? `${intPart}.${fracPart}` : intPart;
    return (negative ? "-" : "") + body;
  }

  /** Fixed number of decimal places, for display. */
  toFixed(dp: number): string {
    const rounded = this.roundToScale(dp, "HALF_UP");
    const negative = rounded.c < 0n;
    const digits = (negative ? -rounded.c : rounded.c).toString();
    if (dp === 0) return (negative ? "-" : "") + digits;
    const padded = digits.padStart(dp + 1, "0");
    const intPart = padded.slice(0, padded.length - dp);
    const fracPart = padded.slice(padded.length - dp);
    return `${negative ? "-" : ""}${intPart}.${fracPart}`;
  }

  /**
   * Lossy conversion to a JS number. For DISPLAY and charting only — never for
   * a value that will be sent back to the exchange. Named to be conspicuous.
   */
  toNumber(): number {
    return Number(this.toString());
  }
}

/**
 * Applies a rounding mode given the truncated quotient and the dropped
 * remainder. `divisor` is the magnitude one whole unit of remainder maps to.
 */
function applyRounding(
  quotient: bigint,
  remainder: bigint,
  divisor: bigint,
  negative: boolean,
  mode: RoundingMode,
  extraNonZero: boolean,
): bigint {
  if (remainder === 0n && !extraNonZero) return quotient;

  const absRem = remainder < 0n ? -remainder : remainder;
  const twiceRem = absRem * 2n;

  switch (mode) {
    case "DOWN":
      return quotient; // toward zero: truncation already did it
    case "UP":
      return quotient + (quotient < 0n ? -1n : 1n);
    case "FLOOR":
      return negative ? quotient - 1n : quotient;
    case "CEIL":
      return negative ? quotient : quotient + 1n;
    case "HALF_UP":
      return twiceRem >= divisor ? quotient + (negative ? -1n : 1n) : quotient;
    case "HALF_EVEN": {
      if (twiceRem > divisor) return quotient + (negative ? -1n : 1n);
      if (twiceRem < divisor) return quotient;
      // exactly half: round to even
      return quotient % 2n === 0n ? quotient : quotient + (negative ? -1n : 1n);
    }
  }
}

/** Convenience constructor. */
export function dec(value: string | number | bigint): Decimal {
  if (typeof value === "string") return Decimal.fromString(value);
  if (typeof value === "bigint") return Decimal.fromBigInt(value);
  return Decimal.fromNumber(value);
}
