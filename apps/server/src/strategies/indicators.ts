/**
 * Technical indicators, hand-rolled to avoid a dependency for ~100 lines of
 * arithmetic. Every function returns a series aligned to the END of the input:
 * the last element corresponds to the last candle. Leading values that cannot
 * be computed are omitted rather than padded, so always check `.length`.
 */

export function sma(values: number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];

  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out.push(sum / period);
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];

  const k = 2 / (period + 1);
  const out: number[] = [];

  // Seed with the SMA of the first `period` values — standard practice, and it
  // avoids the long warm-up bias you get from seeding with values[0].
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);

  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/**
 * Wilder's RSI. Returns values in 0..100.
 */
export function rsi(values: number[], period = 14): number[] {
  if (values.length <= period) return [];

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    gains.push(Math.max(0, change));
    losses.push(Math.max(0, -change));
  }

  const out: number[] = [];
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const toRsi = (g: number, l: number): number =>
    l === 0 ? 100 : 100 - 100 / (1 + g / l);

  out.push(toRsi(avgGain, avgLoss));

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]!) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]!) / period;
    out.push(toRsi(avgGain, avgLoss));
  }
  return out;
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  if (fast.length === 0 || slow.length === 0) {
    return { macd: [], signal: [], histogram: [] };
  }

  // `fast` is longer than `slow`; trim from the front so both end on the same candle.
  const offset = fast.length - slow.length;
  const macdLine = slow.map((s, i) => fast[i + offset]! - s);

  const signalLine = ema(macdLine, signalPeriod);
  if (signalLine.length === 0) return { macd: macdLine, signal: [], histogram: [] };

  const signalOffset = macdLine.length - signalLine.length;
  const histogram = signalLine.map((s, i) => macdLine[i + signalOffset]! - s);

  return { macd: macdLine, signal: signalLine, histogram };
}

export function stdev(values: number[], period: number): number[] {
  if (values.length < period) return [];

  const out: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((acc, v) => acc + (v - mean) ** 2, 0) / period;
    out.push(Math.sqrt(variance));
  }
  return out;
}

export interface BollingerBands {
  upper: number[];
  middle: number[];
  lower: number[];
}

export function bollinger(values: number[], period = 20, mult = 2): BollingerBands {
  const middle = sma(values, period);
  const deviation = stdev(values, period);
  return {
    middle,
    upper: middle.map((m, i) => m + mult * deviation[i]!),
    lower: middle.map((m, i) => m - mult * deviation[i]!),
  };
}

/** True when `series` crossed from below `reference` to above it on the last bar. */
export function crossedAbove(series: number[], reference: number[]): boolean {
  if (series.length < 2 || reference.length < 2) return false;
  const n = series.length;
  const m = reference.length;
  return (
    series[n - 2]! <= reference[m - 2]! && series[n - 1]! > reference[m - 1]!
  );
}

export function crossedBelow(series: number[], reference: number[]): boolean {
  if (series.length < 2 || reference.length < 2) return false;
  const n = series.length;
  const m = reference.length;
  return (
    series[n - 2]! >= reference[m - 2]! && series[n - 1]! < reference[m - 1]!
  );
}

export function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}
