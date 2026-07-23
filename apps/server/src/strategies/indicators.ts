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

// ---------------------------------------------------------------------------
// Volatility & trend-strength
// ---------------------------------------------------------------------------

export interface Bar {
  high: number;
  low: number;
  close: number;
}

/**
 * True Range — the greatest of (high-low), |high-prevClose|, |low-prevClose|.
 *
 * Using the previous close is what makes it "true": a gap open is real range
 * the trader is exposed to, even though it never printed inside the bar.
 */
export function trueRange(bars: Bar[]): number[] {
  if (bars.length < 2) return [];

  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    out.push(
      Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - prevClose),
        Math.abs(bar.low - prevClose),
      ),
    );
  }
  return out;
}

/** Average True Range, Wilder-smoothed. The unit is price, not percent. */
export function atr(bars: Bar[], period = 14): number[] {
  const tr = trueRange(bars);
  if (tr.length < period) return [];

  const out: number[] = [];
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(value);

  for (let i = period; i < tr.length; i++) {
    // Wilder smoothing: equivalent to an EMA with alpha = 1/period.
    value = (value * (period - 1) + tr[i]!) / period;
    out.push(value);
  }
  return out;
}

/** ATR as a fraction of price, so it can be compared across instruments. */
export function atrPercent(bars: Bar[], period = 14): number[] {
  const series = atr(bars, period);
  if (series.length === 0) return [];

  const offset = bars.length - series.length;
  return series.map((value, i) => {
    const close = bars[i + offset]?.close ?? 0;
    return close > 0 ? value / close : 0;
  });
}

/**
 * Average Directional Index — trend STRENGTH, regardless of direction.
 *
 * The conventional reading: below ~20 the market is ranging, above ~25 it is
 * trending. This is the input that lets the engine refuse to run a mean
 * reversion strategy into a strong trend, which is the classic way that
 * otherwise-sound strategy loses money.
 */
export function adx(bars: Bar[], period = 14): number[] {
  if (bars.length < period * 2) return [];

  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i]!.high - bars[i - 1]!.high;
    const downMove = bars[i - 1]!.low - bars[i]!.low;

    // Only the larger move counts, and only when it is positive — a bar that
    // is inside the previous one contributes no directional movement at all.
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const tr = trueRange(bars);
  if (tr.length < period) return [];

  const smooth = (values: number[]): number[] => {
    const out: number[] = [];
    let sum = values.slice(0, period).reduce((a, b) => a + b, 0);
    out.push(sum);
    for (let i = period; i < values.length; i++) {
      sum = sum - sum / period + values[i]!;
      out.push(sum);
    }
    return out;
  };

  const smoothedTr = smooth(tr);
  const smoothedPlus = smooth(plusDM);
  const smoothedMinus = smooth(minusDM);

  const dx: number[] = [];
  for (let i = 0; i < smoothedTr.length; i++) {
    const range = smoothedTr[i]!;
    if (range === 0) {
      dx.push(0);
      continue;
    }
    const plusDI = (smoothedPlus[i]! / range) * 100;
    const minusDI = (smoothedMinus[i]! / range) * 100;
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100);
  }

  if (dx.length < period) return [];

  // ADX is itself a Wilder average of DX.
  const out: number[] = [];
  let value = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(value);
  for (let i = period; i < dx.length; i++) {
    value = (value * (period - 1) + dx[i]!) / period;
    out.push(value);
  }
  return out;
}

/** Directional bias at the last bar: +1 up, -1 down, 0 indeterminate. */
export function directionalBias(bars: Bar[], period = 14): number {
  if (bars.length < period + 1) return 0;

  const recent = bars.slice(-(period + 1));
  const first = recent[0]!.close;
  const last = recent.at(-1)!.close;
  if (first === 0) return 0;

  // Normalise by the MAGNITUDE of the base. Dividing by a signed value would
  // invert the reported direction if a price series ever went negative.
  const change = (last - first) / Math.abs(first);
  if (change > 0.001) return 1;
  if (change < -0.001) return -1;
  return 0;
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

/** Percentage returns from a price series. */
export function returns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]!;
    out.push(prev === 0 ? 0 : (prices[i]! - prev) / prev);
  }
  return out;
}

/**
 * Pearson correlation of two return series, in [-1, 1].
 *
 * Correlation is computed on RETURNS rather than prices: two assets that both
 * drift upward have a high price correlation almost by construction, which
 * tells you nothing about whether they move together day to day.
 */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;

  const x = a.slice(-n);
  const y = b.slice(-n);
  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;

  let covariance = 0;
  let varX = 0;
  let varY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    covariance += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denominator = Math.sqrt(varX * varY);
  // A flat series has zero variance; "no correlation" is the honest answer.
  if (denominator === 0) return 0;

  return Math.max(-1, Math.min(1, covariance / denominator));
}
