/**
 * Incremental feature primitives (§4.2).
 *
 * Every update here is O(1). Recomputing an indicator over its whole window on
 * each tick is the standard way a feature layer becomes the bottleneck: at
 * 50 messages/second across 10 symbols with a 200-period window, the naive
 * version does 100k additions per second to produce numbers that could have
 * been derived from one.
 *
 * Everything is also a pure function of the values it has been fed, in order,
 * so backtest and live produce identical features by construction rather than
 * by careful maintenance of two code paths.
 */

/** Fixed-capacity ring buffer. Overwrites oldest on overflow. */
export class RingBuffer {
  private readonly data: Float64Array;
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (capacity <= 0) throw new Error("RingBuffer capacity must be positive");
    this.data = new Float64Array(capacity);
  }

  push(value: number): number | undefined {
    const evicted = this.count === this.capacity ? this.data[this.head] : undefined;
    this.data[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
    return evicted;
  }

  get size(): number {
    return this.count;
  }

  get full(): boolean {
    return this.count === this.capacity;
  }

  /** Most recent value. */
  get last(): number | undefined {
    if (this.count === 0) return undefined;
    return this.data[(this.head - 1 + this.capacity) % this.capacity];
  }

  /** `i` = 0 is oldest retained value. */
  at(i: number): number | undefined {
    if (i < 0 || i >= this.count) return undefined;
    const start = (this.head - this.count + this.capacity) % this.capacity;
    return this.data[(start + i) % this.capacity];
  }

  toArray(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.at(i)!);
    return out;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

/** Rolling mean maintained by add/evict rather than re-summing. */
export class RollingMean {
  private readonly buffer: RingBuffer;
  private sum = 0;

  constructor(readonly period: number) {
    this.buffer = new RingBuffer(period);
  }

  update(value: number): number | null {
    const evicted = this.buffer.push(value);
    this.sum += value;
    if (evicted !== undefined) this.sum -= evicted;
    return this.ready ? this.value : null;
  }

  get ready(): boolean {
    return this.buffer.full;
  }

  get value(): number {
    return this.buffer.size === 0 ? 0 : this.sum / this.buffer.size;
  }

  reset(): void {
    this.buffer.clear();
    this.sum = 0;
  }
}

/**
 * EMA seeded from the SMA of the first `period` values.
 *
 * Seeding from the first value alone gives a long warm-up bias that makes
 * early backtest bars behave differently from the same bars mid-stream —
 * a subtle source of backtest/live divergence.
 */
export class Ema {
  private readonly k: number;
  private readonly seed: RollingMean;
  private current: number | null = null;

  constructor(readonly period: number) {
    this.k = 2 / (period + 1);
    this.seed = new RollingMean(period);
  }

  update(value: number): number | null {
    if (this.current === null) {
      const seeded = this.seed.update(value);
      if (seeded === null) return null;
      this.current = seeded;
      return this.current;
    }

    this.current = value * this.k + this.current * (1 - this.k);
    return this.current;
  }

  get value(): number | null {
    return this.current;
  }

  reset(): void {
    this.seed.reset();
    this.current = null;
  }
}

/**
 * Welford's online variance.
 *
 * The naive "sum of squares minus square of sum" formulation catastrophically
 * loses precision when the mean is large relative to the variance — exactly
 * the case for asset prices. Welford is numerically stable and still O(1).
 */
export class RollingVariance {
  private readonly buffer: RingBuffer;
  private mean = 0;
  private m2 = 0;

  constructor(readonly period: number) {
    this.buffer = new RingBuffer(period);
  }

  update(value: number): void {
    const evicted = this.buffer.push(value);

    if (evicted === undefined) {
      const n = this.buffer.size;
      const delta = value - this.mean;
      this.mean += delta / n;
      this.m2 += delta * (value - this.mean);
      return;
    }

    // Window is full: remove the evicted sample and add the new one, keeping
    // the count constant.
    const n = this.buffer.size;
    const oldMean = this.mean;
    this.mean = oldMean + (value - evicted) / n;
    this.m2 += (value - evicted) * (value - this.mean + evicted - oldMean);
    // Numerical floor: accumulated error can push m2 slightly negative.
    if (this.m2 < 0) this.m2 = 0;
  }

  get ready(): boolean {
    return this.buffer.size >= 2;
  }

  get variance(): number {
    return this.buffer.size < 2 ? 0 : this.m2 / (this.buffer.size - 1);
  }

  get stdev(): number {
    return Math.sqrt(this.variance);
  }

  reset(): void {
    this.buffer.clear();
    this.mean = 0;
    this.m2 = 0;
  }
}

/** Wilder-smoothed ATR, fed bar by bar. */
export class Atr {
  private prevClose: number | null = null;
  private seed: RollingMean;
  private current: number | null = null;

  constructor(readonly period = 14) {
    this.seed = new RollingMean(period);
  }

  update(high: number, low: number, close: number): number | null {
    const tr =
      this.prevClose === null
        ? high - low
        : Math.max(
            high - low,
            Math.abs(high - this.prevClose),
            Math.abs(low - this.prevClose),
          );
    this.prevClose = close;

    if (this.current === null) {
      const seeded = this.seed.update(tr);
      if (seeded === null) return null;
      this.current = seeded;
      return this.current;
    }

    this.current = (this.current * (this.period - 1) + tr) / this.period;
    return this.current;
  }

  get value(): number | null {
    return this.current;
  }

  reset(): void {
    this.prevClose = null;
    this.seed.reset();
    this.current = null;
  }
}

/**
 * Realised volatility from log returns, annualised.
 *
 * `periodsPerYear` must match the bar interval or the number is meaningless:
 * 1-minute bars are 525_600 per year, 5-minute are 105_120.
 */
export class RealisedVolatility {
  private readonly variance: RollingVariance;
  private prevPrice: number | null = null;

  constructor(
    readonly period = 60,
    private readonly periodsPerYear = 525_600,
  ) {
    this.variance = new RollingVariance(period);
  }

  update(price: number): number | null {
    if (price <= 0) return this.value;

    if (this.prevPrice !== null && this.prevPrice > 0) {
      this.variance.update(Math.log(price / this.prevPrice));
    }
    this.prevPrice = price;
    return this.value;
  }

  get value(): number | null {
    if (!this.variance.ready) return null;
    return this.variance.stdev * Math.sqrt(this.periodsPerYear);
  }

  reset(): void {
    this.variance.reset();
    this.prevPrice = null;
  }
}
